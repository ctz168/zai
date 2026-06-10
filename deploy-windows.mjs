#!/usr/bin/env node
/**
 * Deploy ZAI agent to remote Windows server via SSH
 * Usage: node deploy-windows.mjs
 */
import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = 'aicq.online';
const PORT = 22;
const USER = 'Administrator';
const PASS = 'dongshan168';

const REMOTE_DIR = 'C:\\zai';
const DIST_DIR = join(__dirname, 'dist');

const conn = new Client();

function exec(cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '', stderr = '';
      stream.on('data', (d) => stdout += d.toString());
      stream.stderr.on('data', (d) => stderr += d.toString());
      stream.on('close', (code) => resolve({ stdout, stderr, code }));
    });
  });
}

function putFile(localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const ws = sftp.createWriteStream(remotePath);
      const rs = readFileSync(localPath);
      ws.write(rs);
      ws.end();
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
  });
}

async function run() {
  console.log(`[Deploy] Connecting to ${USER}@${HOST}:${PORT}...`);

  conn.on('ready', async () => {
    console.log('[Deploy] Connected!');

    try {
      // Check Node.js
      let r = await exec('node --version');
      if (r.code !== 0) {
        console.log('[Deploy] Node.js not found. Installing...');
        await exec('winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements');
        r = await exec('node --version');
      }
      console.log(`[Deploy] Node.js: ${r.stdout.trim()}`);

      // Create remote dir
      await exec(`mkdir ${REMOTE_DIR} 2>$null; echo ok`);

      // Check if package.json exists remotely
      r = await exec(`type ${REMOTE_DIR}\\package.json 2>$null`);
      const hasPackage = r.code === 0;

      // Upload package.json and package-lock.json first
      console.log('[Deploy] Uploading package files...');
      await putFile(join(__dirname, 'package.json'), `${REMOTE_DIR}\\package.json`);
      
      // Install dependencies
      console.log('[Deploy] Installing dependencies...');
      await exec(`cd ${REMOTE_DIR} && npm install --production`);

      // Upload dist directory
      console.log('[Deploy] Uploading dist/...');
      await exec(`mkdir ${REMOTE_DIR}\\dist 2>$null; echo ok`);
      
      // Upload all dist files
      const fs = await import('fs');
      const path = await import('path');
      const distDir = join(__dirname, 'dist');
      const files = getAllFiles(distDir);
      
      for (const file of files) {
        const relative = path.relative(distDir, file);
        const remotePath = `${REMOTE_DIR}\\dist\\${relative.replace(/\//g, '\\')}`;
        const remoteFileDir = path.dirname(remotePath);
        
        // Create directory if needed
        await exec(`mkdir "${remoteFileDir}" 2>$null; echo ok`);
        
        // Upload file
        await putFile(file, remotePath);
      }
      console.log(`[Deploy] Uploaded ${files.length} files`);

      // Upload auth.json if exists locally
      const authFile = join(process.env.HOME || '/root', '.zai', 'auth.json');
      try {
        fs.accessSync(authFile);
        console.log('[Deploy] Uploading auth.json...');
        await exec(`mkdir C:\\Users\\Administrator\\.zai 2>$null; echo ok`);
        await putFile(authFile, `C:\\Users\\Administrator\\.zai\\auth.json`);
      } catch {
        console.log('[Deploy] No local auth.json to upload (will use Z.AI login on server)');
      }

      // Upload agent.json if exists
      const agentFile = join(process.env.HOME || '/root', '.zai', 'agent.json');
      try {
        fs.accessSync(agentFile);
        console.log('[Deploy] Uploading agent.json...');
        await putFile(agentFile, `C:\\Users\\Administrator\\.zai\\agent.json`);
      } catch {
        console.log('[Deploy] No agent.json to upload');
      }

      console.log('[Deploy] ✅ Deployment complete!');
      console.log(`[Deploy] To start agent on Windows: cd ${REMOTE_DIR} && node dist/cli.js agent --daemon`);
      
      conn.end();
    } catch (err) {
      console.error('[Deploy] Error:', err);
      conn.end();
      process.exit(1);
    }
  });

  conn.on('error', (err) => {
    console.error('[Deploy] Connection failed:', err.message);
    process.exit(1);
  });

  conn.connect({
    host: HOST,
    port: PORT,
    username: USER,
    password: PASS,
    readyTimeout: 15000,
  });
}

function getAllFiles(dir) {
  const fs = require('fs');
  const path = require('path');
  const results = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      results.push(...getAllFiles(filePath));
    } else {
      results.push(filePath);
    }
  }
  return results;
}

run();
