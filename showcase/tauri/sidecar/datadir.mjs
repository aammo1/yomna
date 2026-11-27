// Where Yomna keeps everything: one visible folder, ~/Yomna, with Agents/, Skills/ and Data/ (settings, memory,
// chats, logs, usage, jobs, MCP servers, sync state, catalogs).
// YOMNA_DATA_DIR (tests and benchmarks) stands in for the home folder.
import os from 'node:os';
import path from 'node:path';

export const baseDir = (env = process.env) => env.YOMNA_DATA_DIR || os.homedir();

// The folder in use: ~/Yomna.
export const yomnaDir = (env = process.env) => dataPaths(env).root;

/** Every path under <base>/Yomna: Data/, Skills/, Agents/, and Data/settings.json. */
export function layout(base) {
  const root = path.join(base, 'Yomna');
  const dir = path.join(root, 'Data');
  return {
    root,
    dir,
    config: path.join(dir, 'settings.json'),
    skills: path.join(root, 'Skills'),
    agents: path.join(root, 'Agents'),
  };
}

const cache = new Map();
/** Paths for the current home (or YOMNA_DATA_DIR); resolved once per folder. */
export function dataPaths(env = process.env) {
  const base = baseDir(env);
  if (!cache.has(base)) cache.set(base, layout(base));
  return cache.get(base);
}

const here = dataPaths();
export const YOMNA_DIR = here.root;
export const DATA_DIR = here.dir;
export const CONFIG_PATH = here.config;
export const SKILLS_DIR = here.skills;
export const AGENTS_DIR = here.agents;
