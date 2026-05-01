#!/usr/bin/env node
/* =========================================================
   scripts/create-user.js — bootstrap a dashboard user.
   ---------------------------------------------------------
   Run from the project root:
     node scripts/create-user.js <username> [--super]

   Works interactively (with hidden password input) OR with
   passwords piped on stdin (one per line, password then confirm):
     printf 'mypass\nmypass\n' | node scripts/create-user.js name --super
   ========================================================= */

import { readFileSync } from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

function loadEnv() {
  try {
    const txt = readFileSync('.env', 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {}
}
loadEnv();

const { stmts }        = await import('../db.js');
const { hashPassword } = await import('../auth.js');

const args = process.argv.slice(2);
const isSuper = args.includes('--super');
const username = args.find(a => !a.startsWith('--'));

if (!username) {
  console.error('usage: node scripts/create-user.js <username> [--super]');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
  console.error('invalid username (3-32 chars, a-z A-Z 0-9 _ . -)');
  process.exit(1);
}

if (stmts.getUserByUsername.get(username)) {
  console.error(`user "${username}" already exists`);
  process.exit(1);
}

/* If stdin is a TTY use raw-mode hidden input.
   Otherwise fall back to a plain readline (works when piped). */
const isInteractive = stdin.isTTY === true;

async function prompt(label, hide = false) {
  if (!hide || !isInteractive) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const v = await rl.question(label);
    rl.close();
    return v;
  }
  return new Promise((resolveP) => {
    stdout.write(label);
    let buf = '';
    const onData = (ch) => {
      ch = ch.toString('utf8');
      for (const c of ch) {
        if (c === '\n' || c === '\r') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          resolveP(buf);
          return;
        } else if (c === '\u0003') {
          process.exit(130);
        } else if (c === '\u007f') {
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

const pw1 = await prompt('password (min 6 chars): ', true);
if (pw1.length < 6) {
  console.error('password too short');
  process.exit(1);
}
const pw2 = await prompt('confirm password: ', true);
if (pw1 !== pw2) {
  console.error('passwords do not match');
  process.exit(1);
}

const hash = await hashPassword(pw1);
const now = Date.now();
stmts.insertUser.run(username, hash, isSuper ? 1 : 0, now, now);

console.log(`created user "${username}"${isSuper ? ' (super-operator)' : ''}`);
console.log('you can now log in at the dashboard.');
process.exit(0);
