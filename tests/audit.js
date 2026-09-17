'use strict';
const assert=require('assert');
const {CARD_NAMES,CONFIGURED}=require('../cards');
const {calcRaw,calcRawBarrier,calcConfigured,areaSeatIndices,sideDamage,hpForPlayers,decksForPlayers}=require('../rules');

assert.strictEqual(CARD_NAMES.length,54,'V1 gameplay catalogue must have 54 unique gameplay cards');
assert.strictEqual(CARD_NAMES.length*2,108,'One gameplay deck must contain 108 cards at 2 copies each');

let r=calcRaw(['Fire','Blade','Compression']);
assert.strictEqual(Math.round(r.base),80);
assert.strictEqual(r.oc,5);
assert.strictEqual(r.flags.blade,true);
assert(Math.abs(r.flags.bladeRatio-.375)<.0001);

r=calcRaw(['Lightning','Air','Wave']);
assert.strictEqual(Math.round(r.base),61); // 55 * 1.10 = 60.5 before nearest-5 resolution
assert.strictEqual(r.flags.wave,true);
assert.strictEqual(r.flags.stun,true);

let b=calcRawBarrier(['Earth','Barrier Form']);
assert.strictEqual(Math.round(b.base),120);
assert.strictEqual(b.oc,2);

let f=calcConfigured('Frost Lance');
assert(Math.abs(f.flags.bladeRatio-(15/35))<.0001);
assert.strictEqual(f.flags.essences[0],'Ice');

assert.deepStrictEqual(areaSeatIndices(2,4),[1,2,3]);
assert.deepStrictEqual(areaSeatIndices(2,3),[1,2,0]);
assert.strictEqual(sideDamage({...calcConfigured('Ricochet Arrow'),damage:25,roll:2}),15);
assert.strictEqual(sideDamage({...calcConfigured('Ricochet Arrow'),damage:55,roll:4}),30);
assert.strictEqual(hpForPlayers(4),300);
assert.strictEqual(hpForPlayers(6),400);
assert.strictEqual(hpForPlayers(8),500);
assert.strictEqual(decksForPlayers(3),1);
assert.strictEqual(decksForPlayers(6),2);
assert.strictEqual(decksForPlayers(8),3);
assert.strictEqual(CONFIGURED['Echo Shell'].shell,true);

const fs=require('fs');
const path=require('path');
const serverSource=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
const htmlSource=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
assert(serverSource.includes('drawCards(room,p,1)'), 'V0.5 must auto-draw 1 at scheduled turn start');
for(const id of ['menu','landing','rulebook','tutorial','lobby','game','cardEncyclopedia']){
  assert(htmlSource.includes(`id="${id}"`), `V0.5 UI missing ${id}`);
}
assert(htmlSource.includes('PLAYER_COLORS'), 'V0.5 player color coding missing');
assert(htmlSource.includes('TUTORIAL_STEPS'), 'V0.5 tutorial missing');

console.log('Echo Clash V0.5 rules + experience audit passed.');
