@echo off
cd /d C:\zai
echo Starting ZAI Agent as daemon...
node dist\cli.js agent --daemon %*
