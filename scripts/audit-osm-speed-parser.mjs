#!/usr/bin/env node
// Use the actual parser function extracted from the importer source; never duplicate its logic.
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync('scripts/build-road-import.mjs','utf8');
const start=src.indexOf('function parseSpeedMph(');
const end=src.indexOf('function normalizeSpeedSource(',start);
if(start<0||end<0) throw Error('Could not locate importer parseSpeedMph');
const parseSpeedMph=vm.runInNewContext('('+src.slice(start,end).trim()+')');
const lines=fs.readFileSync('speed-audit-results/raw-values.csv','utf8').trimEnd().split('\n');
function parseCSV(line){const cells=[];let v='',quote=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quote&&line[i+1]==='"'){v+='"';i++}else quote=!quote}else if(c===','&&!quote){cells.push(v);v=''}else v+=c}cells.push(v);return cells}
function cell(v){v=String(v??'');return /[",\n]/.test(v)?'"'+v.replaceAll('"','""')+'"':v}
const records=[];
for(const line of lines.slice(1)){const [column,raw,count]=parseCSV(line);const mph=parseSpeedMph(raw);const unusual=!/^\d+(?:\.\d+)?(?: mph)?$/i.test(raw.trim());const status=mph===null?'unknown':mph>35?'verified_blocked':'verified_eligible';records.push({column,raw,count:Number(count),mph,status,unusual,suspect:unusual&&mph!==null})}
records.sort((a,b)=>b.count-a.count||a.column.localeCompare(b.column)||a.raw.localeCompare(b.raw));
function write(name,rows){fs.writeFileSync('speed-audit-results/'+name,['column,raw_value,count,parsed_mph,speed_only_lsv_status,suspicious_numeric_parse',...rows.map(r=>[r.column,r.raw,r.count,r.mph??'',r.status,r.suspect].map(cell).join(','))].join('\n')+'\n')}
write('all-parsed-values.csv',records);
write('unusual-values.csv',records.filter(r=>r.unusual));
fs.writeFileSync('speed-audit-results/README.txt','Speed-only LSV status assumes no other access/highway restrictions; actual importer may block on other tags. Source is Geofabrik OSM PBF, not production graph or geometry and not necessarily same snapshot as prior extract.\n');
console.log('Distinct values',records.length,'unusual',records.filter(r=>r.unusual).length,'suspicious numeric',records.filter(r=>r.suspect).length);
