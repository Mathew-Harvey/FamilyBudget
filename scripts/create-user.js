#!/usr/bin/env node
// One off CLI to create a login. There is no sign up page on purpose.
//   npm run create-user
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getPool, closePool, query } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const ENTER_KEYS = ['\r', '\n'];
const BACKSPACE_KEYS = ['', '\b'];
const CTRL_C = '';

// Reads a password without echoing it to the terminal.
async function askHidden(prompt) {
  stdout.write(prompt);
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  try {
    for await (const chunk of stdin) {
      let done = false;
      for (const char of chunk.toString('utf8')) {
        if (ENTER_KEYS.includes(char)) {
          done = true;
          break;
        }
        if (char === CTRL_C) {
          stdout.write('\n');
          process.exit(130);
        }
        if (BACKSPACE_KEYS.includes(char)) {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
      if (done) break;
    }
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
  }
  stdout.write('\n');
  return value;
}

const rl = createInterface({ input: stdin, output: stdout });
// Pull lines from the iterator rather than rl.question. When input is piped
// every line arrives at once, and question() only ever keeps the first.
const lines = rl[Symbol.asyncIterator]();
async function askLine(prompt) {
  stdout.write(prompt);
  const { value, done } = await lines.next();
  if (done) throw new Error('Input ended before the answer.');
  return value;
}

try {
  getPool();
  const email = (await askLine('Email: ')).trim().toLowerCase();
  if (!email.includes('@')) throw new Error('That does not look like an email address.');

  // Hidden entry needs a real terminal. Without one, fall back to a plain read
  // so the script still works when piped.
  const interactive = Boolean(stdin.isTTY);
  if (interactive) rl.pause();
  const password = interactive ? await askHidden('Password: ') : await askLine('Password: ');
  if (password.length < 12) throw new Error('Use at least 12 characters.');
  const again = interactive ? await askHidden('Again: ') : await askLine('Again: ');
  if (password !== again) throw new Error('The two passwords did not match.');

  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `insert into users (email, password_hash) values ($1, $2)
     on conflict (email) do update set password_hash = excluded.password_hash
     returning id, (xmax = 0) as created`,
    [email, passwordHash],
  );
  console.log(rows[0].created ? `Created ${email}.` : `Updated the password for ${email}.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  rl.close();
  await closePool();
}
