/**
 * Autoapply module — self-contained freelance job scraping & application pipeline.
 *
 * Usage in src/index.ts:
 *   import { registerAutoapply } from './autoapply/index.js';
 *   const autoapply = registerAutoapply(deps);
 *
 * This keeps all autoapply logic isolated from core NanoClaw files,
 * preventing merge conflicts on upstream updates.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';

import { logger } from '../logger.js';
import { ContainerOutput } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';

import {
  initOfferStore,
  getOffresDir,
  getUnscoredOffers,
  getScoredWithoutCV,
  getOffersByStatus,
  getOfferStats,
  processScoringResults,
  archiveExpiredOffers,
  purgeOldOffers,
} from './offer-store.js';
import {
  runAllScrapers,
  buildDigest,
  buildScoringPrompt,
} from './orchestrator.js';
import type { ChildProcess } from 'child_process';

// --- Public types ---

export interface AutoapplyDeps {
  /** Send a message to a chat JID. */
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Register a host-side task. */
  registerHostTask: (
    name: string,
    fn: () => Promise<{
      result: string;
      triggerContainer?: { prompt: string };
    }>,
  ) => void;
  /** Get a registered host task by name. */
  getHostTask: (
    name: string,
  ) =>
    | (() => Promise<{ result: string; triggerContainer?: { prompt: string } }>)
    | undefined;
  /** Enqueue a task on the group queue. */
  enqueueTask: (
    chatJid: string,
    taskId: string,
    fn: () => Promise<void>,
  ) => void;
  /** Close stdin of an active container for a given chat. */
  closeStdin: (chatJid: string) => void;
  /** Run a container agent. */
  runContainerAgent: (
    group: RegisteredGroup,
    input: {
      prompt: string;
      sessionId: string;
      groupFolder: string;
      chatJid: string;
      isMain: boolean;
      isScheduledTask: boolean;
      assistantName: string;
    },
    onProcess: (proc: ChildProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
    containerImage?: string,
  ) => Promise<ContainerOutput>;
  /** Look up registered groups. */
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Get session ID for a group folder. */
  getSession: (groupFolder: string) => string;
  /** Set session ID for a group folder. */
  setSession: (groupFolder: string, sessionId: string) => void;
  /** Format outbound text. */
  formatOutbound: (raw: string) => string;
  /** Register a process with the queue. */
  registerProcess: (
    chatJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  /** Assistant name constant. */
  assistantName: string;
  /** Find the right channel for a JID and send. */
  findChannelAndSend: (jid: string, text: string) => Promise<void>;
}

export interface AutoapplyApi {
  /** Enqueue the full autoapply pipeline (scoring → CV → PDF). */
  enqueueContainerRun: (
    chatJid: string,
    prompt: string,
    groupFolder: string,
  ) => void;
  /** Handle run_host_task IPC messages. */
  handleRunHostTask: (
    data: { taskId?: string },
    sourceGroup: string,
    isMain: boolean,
    sendMessage: (jid: string, text: string) => Promise<void>,
    registeredGroups: () => Record<string, RegisteredGroup>,
  ) => Promise<void>;
}

// --- Registration ---

export function registerAutoapply(deps: AutoapplyDeps): AutoapplyApi {
  // Initialize offer store
  initOfferStore();

  // --- Host tasks ---

  deps.registerHostTask('autoapply_scraping', async () => {
    const result = await runAllScrapers();

    const unscoredOffers = getUnscoredOffers();
    const totalRecu = getOffersByStatus('RECU').length;
    const alreadyProcessed = totalRecu - unscoredOffers.length;

    return {
      result: `${result.totalScraped} scraped, ${result.totalInserted} new, ${result.newOffers.length} pertinent, ${unscoredOffers.length} pending, ${alreadyProcessed} already_processed, ${result.totalDuplicates} duplicates, ${result.totalBelowThreshold} ignored`,
      triggerContainer:
        unscoredOffers.length > 0
          ? { prompt: buildScoringPrompt(unscoredOffers.length) }
          : undefined,
    };
  });

  deps.registerHostTask('autoapply_scoring', async () => {
    const unscored = getUnscoredOffers();
    if (unscored.length === 0) {
      return { result: '0 offers to score' };
    }
    return {
      result: `${unscored.length} offers to score`,
      triggerContainer: { prompt: buildScoringPrompt(unscored.length) },
    };
  });

  deps.registerHostTask('autoapply_cv_generation', async () => {
    const needCV = getScoredWithoutCV();
    if (needCV.length === 0) {
      return { result: '0 CVs to generate' };
    }

    const offerPaths = needCV
      .map((o) =>
        o.folderPath.replace(
          getOffresDir(),
          '/workspace/extra/freelance-radar/OFFRES',
        ),
      )
      .join('\n');

    return {
      result: `${needCV.length} CVs to generate`,
      triggerContainer: {
        prompt: `${needCV.length} offres ont passé le scoring Tier 2 et nécessitent un CV adapté.

INSTRUCTIONS :
1. Pour CHAQUE offre ci-dessous :
   a. Lis RAW.json et SCORING.json
   b. Copie le CV source puis adapte-le avec python-docx (skill resume-optimizer)
   c. Envoie un message de progression via mcp__nanoclaw__send_message : "✏️ CV {i}/${needCV.length} : [titre] — CV DOCX généré"
2. APRÈS avoir généré TOUS les CV :
   cd /workspace/extra/freelance-radar && git add -A && git commit -m "feat: CV générés — $(date +%Y-%m-%d)" || true
3. Envoie un message récapitulatif final via mcp__nanoclaw__send_message indiquant :
   - Nombre de CV DOCX générés
   - Liste des offres traitées avec le nom de l'entreprise

IMPORTANT : Génère UNIQUEMENT les fichiers CV .docx. NE PAS générer de PDF.
La conversion PDF est gérée par le host dans une phase séparée.

Profil : /workspace/project/data/freelance/profile.json
CV source : /workspace/project/data/freelance/CV.docx

Offres (${needCV.length}) :
${offerPaths}

Utilise le skill resume-optimizer.`,
      },
    };
  });

  deps.registerHostTask('autoapply_generate_pdfs', async () => {
    const offresDir = getOffresDir();
    const generated: string[] = [];
    const failed: string[] = [];
    let alreadyHavePdf = 0;

    function findCvDocxFiles(
      dir: string,
    ): Array<{ offerDir: string; docxFile: string; hasPdf: boolean }> {
      const results: Array<{
        offerDir: string;
        docxFile: string;
        hasPdf: boolean;
      }> = [];
      if (!fs.existsSync(dir)) return results;

      for (const site of fs.readdirSync(dir)) {
        if (['queue', '.git'].includes(site) || site.startsWith('.')) continue;
        const siteDir = `${dir}/${site}`;
        if (!fs.statSync(siteDir).isDirectory()) continue;

        for (const profile of fs.readdirSync(siteDir)) {
          const profileDir = `${siteDir}/${profile}`;
          if (!fs.statSync(profileDir).isDirectory()) continue;

          for (const status of ['RECU', 'APPLIED']) {
            const statusDir = `${profileDir}/${status}`;
            if (!fs.existsSync(statusDir)) continue;

            for (const folder of fs.readdirSync(statusDir)) {
              const offerDir = `${statusDir}/${folder}`;
              if (!fs.statSync(offerDir).isDirectory()) continue;

              const files = fs.readdirSync(offerDir);
              const docxFiles = files.filter(
                (f) =>
                  (f.startsWith('CV_') || f === 'CV.docx') &&
                  f.endsWith('.docx'),
              );
              for (const docxFile of docxFiles) {
                const pdfFile = docxFile.replace(/\.docx$/, '.pdf');
                results.push({
                  offerDir,
                  docxFile,
                  hasPdf: files.includes(pdfFile),
                });
              }
            }
          }
        }
      }
      return results;
    }

    const allCvs = findCvDocxFiles(offresDir);
    const missing = allCvs.filter((c) => !c.hasPdf);
    alreadyHavePdf = allCvs.filter((c) => c.hasPdf).length;

    logger.info(
      { total: allCvs.length, alreadyHavePdf, missing: missing.length },
      'PDF generation: CV scan complete',
    );

    for (const { offerDir, docxFile } of missing) {
      const pdfResult = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${offerDir}:/work`,
          '-w',
          '/work',
          'docx2pdf:latest',
          `/work/${docxFile}`,
        ],
        { encoding: 'utf-8', timeout: 60_000 },
      );

      if (pdfResult.status === 0) {
        generated.push(`${offerDir}/${docxFile}`);
        logger.info(
          { dir: offerDir, file: docxFile },
          'PDF generated (fallback)',
        );
      } else {
        failed.push(`${offerDir}/${docxFile}`);
        logger.warn(
          { dir: offerDir, file: docxFile, stderr: pdfResult.stderr },
          'PDF generation failed',
        );
      }
    }

    const parts: string[] = [];
    if (alreadyHavePdf > 0) parts.push(`${alreadyHavePdf} PDFs déjà présents`);
    if (generated.length > 0)
      parts.push(`${generated.length} PDFs convertis (fallback)`);
    if (failed.length > 0) parts.push(`${failed.length} échecs`);
    if (missing.length === 0 && alreadyHavePdf === 0)
      parts.push('aucun CV trouvé');

    return { result: parts.join(', ') };
  });

  deps.registerHostTask('autoapply_generate_messages', async () => {
    const offresDir = getOffresDir();
    const missingMessages: Array<{
      site: string;
      profile: string;
      folder: string;
      dir: string;
    }> = [];

    if (!fs.existsSync(offresDir)) {
      return { result: 'OFFRES directory not found' };
    }

    // Scan RECU and APPLIED for offers with CV but no message
    for (const site of fs.readdirSync(offresDir)) {
      if (['queue', '.git'].includes(site) || site.startsWith('.')) continue;
      const siteDir = `${offresDir}/${site}`;
      if (!fs.statSync(siteDir).isDirectory()) continue;

      for (const profile of fs.readdirSync(siteDir)) {
        const profileDir = `${siteDir}/${profile}`;
        if (!fs.statSync(profileDir).isDirectory()) continue;

        for (const status of ['RECU', 'APPLIED']) {
          const statusDir = `${profileDir}/${status}`;
          if (!fs.existsSync(statusDir)) continue;

          for (const folder of fs.readdirSync(statusDir)) {
            const offerDir = `${statusDir}/${folder}`;
            if (!fs.statSync(offerDir).isDirectory()) continue;

            const files = fs.readdirSync(offerDir);
            const hasCV = files.some(
              (f) => f.startsWith('CV_') && f.endsWith('.docx'),
            );
            const descPath = `${offerDir}/DESCRIPTION.md`;
            if (!hasCV || !fs.existsSync(descPath)) continue;

            const descContent = fs.readFileSync(descPath, 'utf-8');
            if (!descContent.includes('## Message de réponse')) {
              missingMessages.push({ site, profile, folder, dir: offerDir });
            }
          }
        }
      }
    }

    logger.info(
      { count: missingMessages.length },
      'autoapply_generate_messages: offers needing response message',
    );

    if (missingMessages.length === 0) {
      return { result: 'Tous les CVs ont déjà un message de réponse' };
    }

    const offerList = missingMessages
      .map(
        (o) =>
          `/workspace/extra/freelance-radar/OFFRES/${o.site}/${o.profile}/RECU/${o.folder}`,
      )
      .join('\n');

    return {
      result: `${missingMessages.length} offres sans message de réponse`,
      triggerContainer: {
        prompt: `Tu dois générer un "Message de réponse" pour ${missingMessages.length} offres freelance qui ont un CV adapté mais pas encore de message de prise de contact.

Pour CHAQUE offre dans la liste ci-dessous :
1. Lis \`RAW.json\` et \`DESCRIPTION.md\`
2. Génère un message de réponse personnalisé < 2000 caractères (compte les caractères avant d'écrire)
3. Appende-le à la fin de \`DESCRIPTION.md\` via :
   \`\`\`bash
   cat >> {offer_dir}/DESCRIPTION.md << 'MSGEOF'

## Message de réponse

{message ici}

---
*Généré automatiquement — à relire avant envoi.*
MSGEOF
   \`\`\`
4. Envoie une progression via mcp__nanoclaw__send_message : "✍️ Message généré pour {titre} ({i}/{N})"

Le message doit :
- Être < 2000 caractères (espaces compris)
- Mentionner le nom de l'entreprise si disponible dans RAW.json
- Citer 2-3 éléments spécifiques de l'offre
- Mettre en avant les points du profil qui matchent
- Mentionner la disponibilité et le TJM si pertinent
- Ton professionnel, direct, sans formules creuses

Profil : /workspace/project/data/freelance/profile.json

Offres à traiter (${missingMessages.length}) :
${offerList}

Après avoir tout traité, envoie via mcp__nanoclaw__send_message :
"✅ Messages de réponse générés pour ${missingMessages.length} offres. Pensez à les relire avant envoi."`,
      },
    };
  });

  deps.registerHostTask('autoapply_cleanup', async () => {
    const expired = archiveExpiredOffers(30);
    const purged = purgeOldOffers(90);
    return { result: `${expired} archived, ${purged} purged` };
  });

  logger.info('Autoapply host tasks registered');

  // --- Pipeline ---

  function enqueueContainerRun(
    chatJid: string,
    prompt: string,
    groupFolder: string,
  ): void {
    logger.info(
      { chatJid, groupFolder, promptLength: prompt.length },
      '[AUTOAPPLY] enqueueContainerRun called',
    );
    const group = Object.values(deps.registeredGroups()).find(
      (g) => g.folder === groupFolder,
    );
    if (!group) {
      logger.warn(
        { groupFolder },
        '[AUTOAPPLY] Cannot enqueue container: group not found',
      );
      return;
    }
    const isMain = group.isMain === true;

    const runContainer = async (
      containerPrompt: string,
      image?: string,
    ): Promise<void> => {
      const output = await deps.runContainerAgent(
        group,
        {
          prompt: containerPrompt,
          sessionId: deps.getSession(groupFolder),
          groupFolder,
          chatJid,
          isMain,
          isScheduledTask: true,
          assistantName: deps.assistantName,
        },
        (proc, containerName) =>
          deps.registerProcess(chatJid, proc, containerName, groupFolder),
        async (streamedOutput: ContainerOutput) => {
          if (streamedOutput.result) {
            const text = deps.formatOutbound(streamedOutput.result);
            if (text) await deps.sendMessage(chatJid, text);
          }
          if (streamedOutput.status === 'success') {
            deps.closeStdin(chatJid);
          }
        },
        image,
      );
      if (output.newSessionId) {
        deps.setSession(groupFolder, output.newSessionId);
      }
    };

    const sendMsg = async (text: string) => {
      await deps.sendMessage(chatJid, text);
    };

    deps.enqueueTask(chatJid, `autoapply-pipeline-${Date.now()}`, async () => {
      // --- Phase 2a: Scoring Tier 2 (uses scorer image — no python-docx) ---
      logger.info('[AUTOAPPLY] Phase 2a: Scoring');
      await runContainer(prompt, 'nanoclaw-scorer:latest');

      // --- Post-scoring: host processes results ---
      logger.info('[AUTOAPPLY] Processing scoring results (host-side)');
      const bilan = processScoringResults();

      const totalToGenerate = getScoredWithoutCV().length;

      await sendMsg(
        `📊 *Bilan scoring Tier 2*\n\n` +
          `• ${bilan.apply} offres "apply"\n` +
          `• ${bilan.maybe} offres "maybe"\n` +
          `• ${bilan.skip} archivées (skip) avec cause.md\n` +
          `• ${bilan.unscored} non scorées (SCORING.json manquant)\n` +
          `• ${totalToGenerate} CV à générer` +
          (bilan.errors.length > 0 ? `\n• ${bilan.errors.length} erreurs` : ''),
      );

      if (totalToGenerate === 0) {
        logger.info(
          '[AUTOAPPLY] No offers to generate CV for, skipping CV phase',
        );
        await sendMsg(`✅ Aucun CV à générer.`);

        // Still run PDF check to inform user of current state
        const pdfTask = deps.getHostTask('autoapply_generate_pdfs');
        if (pdfTask) {
          const pdfResult = await pdfTask();
          await sendMsg(`📄 ${pdfResult.result}`);
        }

        const stats = getOfferStats();
        await sendMsg(
          `✅ *Pipeline terminé*\n\n` +
            `• ${stats.recu} offres en attente\n` +
            `• ${stats.applied} candidatures\n` +
            `• ${stats.archived} archivées\n` +
            `• ${stats.total} total`,
        );
        return;
      }

      // --- Phase 2b: CV generation ---
      const cvTask = deps.getHostTask('autoapply_cv_generation');
      if (cvTask) {
        const cvResult = await cvTask();
        logger.info(
          { result: cvResult.result },
          '[AUTOAPPLY] CV generation check',
        );

        if (cvResult.triggerContainer) {
          await sendMsg(
            `✏️ *Génération CV* : ${totalToGenerate} CV à adapter...`,
          );
          logger.info('[AUTOAPPLY] Phase 2b: CV generation');
          await runContainer(cvResult.triggerContainer.prompt);
          await sendMsg(`✅ Génération CV terminée.`);
        }
      }

      // --- Phase 3: PDF generation ---
      const pdfTask = deps.getHostTask('autoapply_generate_pdfs');
      if (pdfTask) {
        logger.info('[AUTOAPPLY] Phase 3: PDF generation');
        const pdfResult = await pdfTask();
        logger.info(
          { result: pdfResult.result },
          '[AUTOAPPLY] PDF generation completed',
        );
        await sendMsg(`📄 ${pdfResult.result}`);
      }

      // --- Final summary ---
      const stats = getOfferStats();
      await sendMsg(
        `✅ *Pipeline terminé*\n\n` +
          `• ${stats.recu} offres en attente\n` +
          `• ${stats.applied} candidatures\n` +
          `• ${stats.archived} archivées\n` +
          `• ${stats.total} total`,
      );
    });
    logger.info(
      { chatJid, groupFolder },
      'Autoapply pipeline enqueued (scoring → CV → PDF)',
    );
  }

  // --- IPC handler ---

  async function handleRunHostTask(
    data: { taskId?: string },
    sourceGroup: string,
    isMain: boolean,
    sendMessage: (jid: string, text: string) => Promise<void>,
    registeredGroups: () => Record<string, RegisteredGroup>,
  ): Promise<void> {
    if (!isMain) {
      logger.warn(
        { sourceGroup },
        'Unauthorized run_host_task attempt blocked',
      );
      return;
    }
    if (!data.taskId) return;

    const fn = deps.getHostTask(data.taskId);
    if (!fn) {
      logger.warn(
        { taskId: data.taskId },
        'Unknown host task requested via IPC',
      );
      return;
    }

    logger.info(
      { taskId: data.taskId, sourceGroup },
      'Running host task via IPC',
    );
    const startTime = Date.now();

    try {
      const { result, triggerContainer } = await fn();
      logger.info(
        { taskId: data.taskId, durationMs: Date.now() - startTime, result },
        'Host task completed via IPC',
      );

      // Resolve chatJid for this group
      const chatJid = Object.entries(registeredGroups()).find(
        ([, g]) => g.folder === sourceGroup,
      )?.[0];

      if (triggerContainer) {
        logger.info(
          {
            taskId: data.taskId,
            promptLength: triggerContainer.prompt.length,
          },
          '[AUTOAPPLY] Preparing follow-up container',
        );
        if (chatJid) {
          // Send digest
          const digest = buildDigest(result);
          if (digest) {
            logger.info(
              { digestLength: digest.length },
              '[AUTOAPPLY] Sending digest to user',
            );
            await sendMessage(chatJid, digest);
          } else {
            logger.warn('[AUTOAPPLY] buildDigest returned null');
          }

          // Notify phase 2
          const pendingMatch = result.match(/(\d+) pending/);
          const pendingCount = pendingMatch ? pendingMatch[1] : '?';
          await sendMessage(
            chatJid,
            `🔄 *Phase 2* : scoring sémantique de ${pendingCount} offres en cours...`,
          );

          // Trigger pipeline
          logger.info(
            {
              chatJid,
              sourceGroup,
              promptLength: triggerContainer.prompt.length,
            },
            '[AUTOAPPLY] Enqueuing container for Tier 2 + CV',
          );
          enqueueContainerRun(chatJid, triggerContainer.prompt, sourceGroup);
        } else {
          logger.warn(
            { sourceGroup },
            '[AUTOAPPLY] No chatJid found for group',
          );
        }
      } else {
        logger.info(
          { taskId: data.taskId },
          '[AUTOAPPLY] No pending offers, skipping Tier 2',
        );
        if (chatJid) {
          const digest = buildDigest(result);
          if (digest) {
            await sendMessage(chatJid, digest);
          }
          await sendMessage(
            chatJid,
            `✅ Aucune offre en attente — pas de phase 2 nécessaire.`,
          );
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: data.taskId, error }, 'Host task failed via IPC');
    }
  }

  return { enqueueContainerRun, handleRunHostTask };
}
