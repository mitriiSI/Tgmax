import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTransferTime, formatEta, createProgressEmitter } from '../src/network-monitor.js';

test('ETA splits Telegram download and MAX upload using separate speeds', () => {
  const result = estimateTransferTime(100 * 1024 * 1024, { downloadMbps: 100, uploadMbps: 20 });
  assert.ok(result.downloadSeconds > 8 && result.downloadSeconds < 9);
  assert.ok(result.uploadSeconds > 41 && result.uploadSeconds < 43);
  assert.ok(result.totalSeconds > result.downloadSeconds + result.uploadSeconds);
  assert.equal(formatEta(65), '1 мин 5 с');
});

test('progress emitter publishes waiting heartbeat and live bytes', () => {
  const events=[];
  const emit=createProgressEmitter({log:{event:(e)=>events.push(e)},operationId:'op',direction:'telegram_to_max',stage:'download',event:'progress',label:'Telegram → сервер',startProgress:10,endProgress:50,totalBytesHint:1000,minIntervalMs:0});
  emit({waiting:true,elapsedMs:2000,force:true});
  emit({bytes:500,totalBytes:1000,force:true});
  emit({bytes:1000,totalBytes:1000,done:true,force:true});
  assert.match(events[0].message,/подготавливает большой файл/);
  assert.equal(events[1].details.percent,50);
  assert.equal(events.at(-1).progress,50);
});
