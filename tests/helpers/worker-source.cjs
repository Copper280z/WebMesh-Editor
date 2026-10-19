const fs = require('node:fs');
const path = require('node:path');
const file = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'card-worker.js'), 'utf8');
const marker = 'function webMeshCardWorker() {';
const start = file.indexOf(marker) + marker.length;
module.exports = file.slice(start, file.lastIndexOf('};'));
