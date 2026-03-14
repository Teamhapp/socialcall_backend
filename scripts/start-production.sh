#!/bin/bash
# Production startup script
# Runs DB migrations then starts the Node server
node scripts/migrate.js
exec node server.js
