'use strict';
// Tâches de fond en mémoire. Une recherche IA dure 30 à 90 s : sur téléphone, un écran qui se verrouille
// ou un onglet passé en arrière-plan coupe la requête HTTP. Ici le travail continue côté serveur et le
// navigateur vient chercher le résultat (même après un rechargement de la page).
const crypto = require('node:crypto');

function createJobs({ ttlMs = 15 * 60 * 1000, maxRunning = 3, timeoutMs = 240000 } = {}) {
  const jobs = new Map();

  function sweep() {
    const now = Date.now();
    for (const [id, j] of jobs) if (j.status !== 'running' && now - (j.finishedAt || j.createdAt) > ttlMs) jobs.delete(id);
  }

  function running() {
    let n = 0;
    for (const j of jobs.values()) if (j.status === 'running') n++;
    return n;
  }

  // fn(report) -> Promise<résultat>. report(message) ajoute une étape de progression visible côté client.
  function start(fn) {
    sweep();
    if (running() >= maxRunning) {
      throw Object.assign(new Error('Plusieurs recherches sont déjà en cours. Patiente quelques secondes.'), { status: 429, code: 'BUSY' });
    }
    const id = crypto.randomUUID();
    const job = { id, status: 'running', steps: [], result: null, error: null, createdAt: Date.now(), finishedAt: null };
    jobs.set(id, job);
    const report = (msg) => {
      job.steps.push({ at: Date.now(), msg: String(msg).slice(0, 200) });
      if (job.steps.length > 40) job.steps.shift();
    };
    const timer = new Promise((_, rej) => {
      const t = setTimeout(() => rej(Object.assign(new Error('La recherche a pris trop de temps. Réessaie.'), { code: 'JOB_TIMEOUT' })), timeoutMs);
      t.unref();
    });
    Promise.race([Promise.resolve().then(() => fn(report)), timer])
      .then((r) => { job.result = r; job.status = 'done'; })
      .catch((e) => {
        const known = e && e.code && e.message && e.status;
        if (!known && e && e.code !== 'JOB_TIMEOUT') console.error('[tâche]', e);
        job.error = known || (e && e.code === 'JOB_TIMEOUT')
          ? { code: e.code, message: e.message }
          : { code: 'INTERNAL', message: 'Erreur interne du serveur.' };
        job.status = 'error';
      })
      .finally(() => { job.finishedAt = Date.now(); });
    return id;
  }

  function view(id) {
    const j = jobs.get(id);
    if (!j) return null;
    return { id: j.id, status: j.status, steps: j.steps, result: j.status === 'done' ? j.result : null, error: j.error, elapsedMs: (j.finishedAt || Date.now()) - j.createdAt };
  }

  return { start, view, size: () => jobs.size };
}

module.exports = { createJobs };
