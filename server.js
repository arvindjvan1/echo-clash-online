
'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, version: '0.4.1-alpha' }));

const rooms = new Map();

const RAW = {
  Fire:{kind:'Essence',d:25,oc:1},
  Water:{kind:'Essence',d:15,oc:1},
  Earth:{kind:'Essence',d:20,oc:1},
  Air:{kind:'Essence',d:15,oc:1},
  Ice:{kind:'Essence',d:20,oc:2},
  Lightning:{kind:'Essence',d:25,oc:2},
  Acid:{kind:'Essence',d:15,oc:2},

  Projectile:{kind:'Form',d:10,oc:1},
  Wave:{kind:'Form',d:15,oc:2},
  Blade:{kind:'Form',d:15,oc:2},
  Burst:{kind:'Form',d:20,oc:2},
  Bind:{kind:'Form',d:5,oc:2},
  Coat:{kind:'Form',d:5,oc:1},

  Compression:{kind:'Force',mult:2,oc:2},
  Acceleration:{kind:'Force',mult:2,oc:2},
  Amplifier:{kind:'Force',mult:3,oc:3},
  Explosion:{kind:'Force',mult:4,oc:4},
};

const CONFIGURED = {
  Fireball:{kind:'Configured',d:70,oc:4},
  'Lightning Arc':{kind:'Configured',d:60,oc:5,wave:true,stun:true},
  'Frost Lance':{kind:'Configured',d:35,oc:4,blade:true,bladeBase:15,totalBase:35},
  'Corrosive Surge':{kind:'Configured',d:45,oc:5,wave:true,corrode:true},
  'Flame Mantle':{kind:'Configured',d:30,oc:2,burn:true},
  'Stone Spikes':{kind:'Configured',d:25,oc:3,bind:true},
  'Thunder Burst':{kind:'Configured',d:45,oc:4,burst:true},
  'Gale Shot':{kind:'Configured',d:50,oc:4},
  'Phase Strike':{kind:'Configured',d:40,oc:4,phase:true},
  'Echo Shell':{kind:'Configured',d:0,oc:3,shell:true},
  'Ricochet Arrow':{kind:'Configured',d:45,oc:4,ricochet:true},
  'Echo Collapse':{kind:'Configured',d:20,oc:4,collapse:true},
};

const MONSTERS = {
  Ashfang:{kind:'Monster',hp:140,guard:.40,atk:30},
  Stoneback:{kind:'Monster',hp:160,guard:.60,atk:20,mitigation:10},
  Stormclaw:{kind:'Monster',hp:130,guard:.45,atk:25},
  Rotcrawler:{kind:'Monster',hp:120,guard:.35,atk:20},
  Emberhide:{kind:'Monster',hp:150,guard:.50,atk:20},
  Shardling:{kind:'Monster',hp:100,guard:.30,atk:15,stabilityBonus:1},
};

const BARRIERS = {
  'Earth Barrier':{kind:'Barrier',hp:120,oc:2},
  'Flame Barrier':{kind:'Barrier',hp:105,oc:2,retaliate:5},
  'Water Barrier':{kind:'Barrier',hp:95,oc:2,reduce:10},
  'Wind Barrier':{kind:'Barrier',hp:95,oc:2,projectileReduce:15},
  'Ice Barrier':{kind:'Barrier',hp:100,oc:3,onBreak:'freeze'},
  'Lightning Barrier':{kind:'Barrier',hp:105,oc:3,retaliate:5,breakRetaliate:10},
  'Acid Barrier':{kind:'Barrier',hp:95,oc:3,corrodeAttacker:true},
  'Storm Barrier':{kind:'Barrier',hp:120,oc:4,onBreak:'storm'},
  'Magma Barrier':{kind:'Barrier',hp:150,oc:3,retaliate:5,breakRetaliate:10},
  'Glacial Barrier':{kind:'Barrier',hp:115,oc:4,reduce:10,onBreak:'freeze'},
  'Inferno Barrier':{kind:'Barrier',hp:130,oc:3,inferno:true},
  'Permafrost Barrier':{kind:'Barrier',hp:145,oc:4,onBreak:'stabilityDown'},
};

const SUPPORT = {
  Heal:{kind:'Support'},
  'Stability Boost':{kind:'Support'},
  'Output Boost':{kind:'Support'},
  Cleanse:{kind:'Support'},
  'Monster Heal':{kind:'Support'},
  Stabilize:{kind:'Support'},
};

const ALL = {...RAW, ...CONFIGURED, ...MONSTERS, ...BARRIERS, ...SUPPORT};
const CARD_NAMES = Object.keys(ALL);

const id = (prefix='x') => `${prefix}_${crypto.randomBytes(7).toString('hex')}`;
const clamp = (n,min,max) => Math.max(min, Math.min(max,n));

function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function roomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s='';
  for(let i=0;i<6;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}

function baseDeck(){
  const d=[];
  for(const n of CARD_NAMES) d.push(n,n); // 108 gameplay cards
  return d;
}

function hpForPlayers(n){
  if(n>=7) return 500;
  if(n>=5) return 400;
  return 300;
}
function decksForPlayers(n){ return Math.ceil(n/3); }

function makePlayer(name,isAI=false){
  return {
    id:id('p'), token:id('tok'), name:(name||'Player').slice(0,24),
    isAI, connected:isAI, socketId:null, ready:isAI, alive:true,

    hand:[], hp:300, maxHp:300,
    output:5, stability:3,
    tempOutput:0, tempStability:0,
    stabilize:false,

    strikes:0, lossStreak:0,
    ruptureStrain:0, ruptureChain:0,
    gainedStrainThisRound:false, rupturedThisRound:false, safeRounds:0,

    monster:null, barrier:null, lingering:[], skipTurns:0,
  };
}

function makeRoom(hostName,totalSeats,aiSeats,diceMode,disconnectMode){
  let code;
  do code=roomCode(); while(rooms.has(code));

  const host=makePlayer(hostName||'Host',false);
  host.connected=true;
  host.ready=true;

  const total=clamp(Number(totalSeats)||4,2,8);
  const ais=clamp(Number(aiSeats)||0,0,total-1);

  const room={
    code, status:'lobby', hostId:host.id,
    settings:{
      totalSeats:total,
      aiSeats:ais,
      diceMode:diceMode==='physical'?'physical':'virtual',
      disconnectMode:disconnectMode==='grace'?'grace':'autopass',
      graceMs:5*60*1000,
    },
    players:[host],
    deck:[], recycle:[],
    round:1, turnIndex:0, phase:'lobby', pending:null,
    log:[], tieBreaker:false, createdAt:Date.now(),
  };

  for(let i=0;i<ais;i++) room.players.push(makePlayer(`AI ${i+1}`,true));
  rooms.set(code,room);
  return room;
}

function log(room,text){
  room.log.push({time:Date.now(),text});
  if(room.log.length>350) room.log.shift();
}

function playerById(room,pid){ return room.players.find(p=>p.id===pid); }
function alivePlayers(room){ return room.players.filter(p=>p.alive); }
function effectiveOutput(p){ return p.output+p.tempOutput; }
function effectiveStability(p){
  return p.stability+p.tempStability+(p.monster&&MONSTERS[p.monster.name]?.stabilityBonus||0);
}
function socketFor(p){ return p.socketId ? io.sockets.sockets.get(p.socketId) : null; }

function publicPlayer(p,viewerId){
  return {
    id:p.id,name:p.name,isAI:p.isAI,connected:p.connected,ready:p.ready,alive:p.alive,
    hp:p.hp,maxHp:p.maxHp,output:p.output,stability:p.stability,
    effectiveOutput:effectiveOutput(p),effectiveStability:effectiveStability(p),
    strikes:p.strikes,lossStreak:p.lossStreak,ruptureStrain:p.ruptureStrain,
    handCount:p.hand.length,hand:p.id===viewerId?p.hand:undefined,
    monster:p.monster,barrier:p.barrier,lingering:p.lingering,skipTurns:p.skipTurns,
  };
}

function serialize(room,viewerId){
  const current=room.status==='playing'?room.players[room.turnIndex]:null;
  return {
    code:room.code,status:room.status,hostId:room.hostId,settings:room.settings,
    players:room.players.map(p=>publicPlayer(p,viewerId)),
    viewerId,round:room.round,turnPlayerId:current?.id||null,
    phase:room.phase,
    pending:room.pending?{
      kind:room.pending.kind,
      playerId:room.pending.playerId,
      attackerId:room.pending.attackerId,
      defenderId:room.pending.defenderId,
      label:room.pending.label,
      diceMode:room.pending.diceMode,
    }:null,
    log:room.log.slice(-140),
    deckCount:room.deck.length,recycleCount:room.recycle.length,
    tieBreaker:room.tieBreaker,
  };
}

function emitRoom(room){
  for(const p of room.players){
    const s=socketFor(p);
    if(s) s.emit('state',serialize(room,p.id));
  }
}
function gameError(socket,message){ socket.emit('game_error',{message}); }

function drawOne(room){
  if(!room.deck.length){
    if(!room.recycle.length) return null;
    room.deck=shuffle(room.recycle.splice(0));
    log(room,'Returned cards reshuffled into the Main Deck.');
  }
  return room.deck.pop()||null;
}
function drawCards(room,p,n){
  for(let i=0;i<n;i++){
    const card=drawOne(room);
    if(card) p.hand.push(card);
  }
}
function recycle(room,cards){ room.recycle.unshift(...cards); }

function allReady(room){
  return room.players.length===room.settings.totalSeats &&
    room.players.filter(p=>!p.isAI).every(p=>p.connected&&p.ready);
}

function resetPlayerForMatch(p,hp){
  Object.assign(p,{
    alive:true,hand:[],maxHp:hp,hp,
    output:5,stability:3,tempOutput:0,tempStability:0,stabilize:false,
    strikes:0,lossStreak:0,ruptureStrain:0,ruptureChain:0,
    gainedStrainThisRound:false,rupturedThisRound:false,safeRounds:0,
    monster:null,barrier:null,lingering:[],skipTurns:0,
  });
}

function startGame(room){
  const hp=hpForPlayers(room.players.length);
  room.deck=[];
  for(let i=0;i<decksForPlayers(room.players.length);i++) room.deck.push(...baseDeck());
  shuffle(room.deck);
  room.recycle=[];

  for(const p of room.players){
    resetPlayerForMatch(p,hp);
    drawCards(room,p,12);
  }

  room.status='playing';
  room.phase='action';
  room.round=1;
  room.turnIndex=0;
  room.pending=null;
  room.tieBreaker=false;
  log(room,`Round 1 begins. ${room.players.map(p=>p.name).join(' → ')}`);
  beginTurn(room);
}

function nextAliveIndex(room,from){
  for(let step=1;step<=room.players.length;step++){
    const idx=(from+step)%room.players.length;
    if(room.players[idx].alive) return idx;
  }
  return from;
}

function finishRound(room){
  for(const p of room.players){
    if(!p.alive) continue;

    if(!p.rupturedThisRound) p.ruptureChain=0;

    if(p.ruptureStrain>0){
      if(p.gainedStrainThisRound) p.safeRounds=0;
      else {
        p.safeRounds++;
        if(p.safeRounds>=2){
          p.ruptureStrain=Math.max(0,p.ruptureStrain-1);
          p.safeRounds=0;
          log(room,`${p.name}'s Rupture Strain cools by 1.`);
        }
      }
    }else p.safeRounds=0;

    p.gainedStrainThisRound=false;
    p.rupturedThisRound=false;
  }
  room.round++;
  log(room,`Round ${room.round} begins.`);
}

function advanceTurn(room){
  if(room.status!=='playing') return;

  const old=room.turnIndex;
  const next=nextAliveIndex(room,old);
  if(next<=old) finishRound(room);

  room.turnIndex=next;
  room.phase='action';
  room.pending=null;
  beginTurn(room);
}

function beginTurn(room){
  if(room.status!=='playing') return;
  const p=room.players[room.turnIndex];

  if(!p?.alive){ advanceTurn(room); return; }

  // Lingering ticks only at the start of the affected player's scheduled turn.
  if(p.lingering.length){
    const keep=[];
    for(const e of p.lingering){
      p.hp-=e.damage;
      log(room,`${p.name} suffers D${e.damage} ${e.kind}.`);
      e.turns--;
      if(e.turns>0) keep.push(e);
    }
    p.lingering=keep;

    if(p.hp<=0) eliminate(room,p);
    if(room.status!=='playing') return;
    if(!p.alive){ advanceTurn(room); return; }
  }

  if(p.skipTurns>0){
    p.skipTurns--;
    log(room,`${p.name} is Stunned/Frozen and skips the scheduled turn.`);
    advanceTurn(room);
    return;
  }

  room.phase='action';

  if(p.isAI) setTimeout(()=>aiTurn(room,p),250);
  else if(!p.connected && room.settings.disconnectMode==='autopass'){
    log(room,`${p.name} is disconnected and auto-passes.`);
    advanceTurn(room);
    return;
  }

  emitRoom(room);
}

function validateIndices(p,indices){
  if(!Array.isArray(indices)||!indices.length) return null;
  const uniq=[...new Set(indices.map(Number))];
  if(uniq.some(i=>!Number.isInteger(i)||i<0||i>=p.hand.length)) return null;
  return uniq.sort((a,b)=>a-b);
}
function namesAt(p,indices){ return indices.map(i=>p.hand[i]); }
function consumeIndices(room,p,indices){
  const cards=namesAt(p,indices);
  for(const i of [...indices].sort((a,b)=>b-a)) p.hand.splice(i,1);
  recycle(room,cards);
  return cards;
}

function analyzeSelection(names){
  const metas=names.map(n=>ALL[n]);
  if(metas.some(x=>!x)) return {error:'Unknown card.'};

  const nonRaw=metas.filter(m=>!['Essence','Form','Force'].includes(m.kind));
  if(nonRaw.length){
    if(names.length!==1) return {error:'Configured, Monster, Barrier and Support cards are individual Actions.'};
    return {type:nonRaw[0].kind,name:names[0],meta:nonRaw[0]};
  }

  const ess=names.filter(n=>RAW[n]?.kind==='Essence');
  const forms=names.filter(n=>RAW[n]?.kind==='Form');
  if(!ess.length) return {error:'Raw Configuration needs at least one Essence.'};
  if(forms.length>1) return {error:'Only one Form per Raw Configuration.'};
  return {type:'Raw',names};
}

/*
Blade exact split:
- Blade itself contributes +D15.
- The Essence contribution penetrates the Barrier.
- Every synergy / Force / d4 multiplier scales both parts equally.
- No arbitrary 45/55 split.
The split ratio is derived from the actual pre-multiplier components.
*/
function calcRaw(names){
  const essences=names.filter(n=>RAW[n]?.kind==='Essence');
  const form=names.find(n=>RAW[n]?.kind==='Form');
  const forces=names.filter(n=>RAW[n]?.kind==='Force');

  const essenceBase=essences.reduce((sum,n)=>sum+RAW[n].d,0);
  const formBase=form?RAW[form].d:0;
  let totalBase=essenceBase+formBase;

  const flags={form,essences:[...essences]};

  if(essences.includes('Fire')&&essences.includes('Air')) totalBase*=1.10;
  if(essences.includes('Lightning')&&essences.includes('Air')){
    totalBase*=1.10;
    flags.stun=true;
  }
  if(essences.includes('Ice')&&essences.includes('Air')) flags.freeze=true;
  if(essences.includes('Acid')&&essences.includes('Water')) flags.corrode=true;

  if(form==='Blade'){
    flags.blade=true;
    flags.bladeRatio=(essenceBase+formBase)>0 ? formBase/(essenceBase+formBase) : 0;
  }
  if(form==='Wave') flags.wave=true;
  if(form==='Burst') flags.burst=true;
  if(form==='Bind') flags.bind=true;
  if(form==='Coat') flags.coat=true;

  for(const force of forces) totalBase*=RAW[force].mult;

  return {
    base:totalBase,
    oc:names.reduce((sum,n)=>sum+RAW[n].oc,0),
    flags,
    label:names.join(' + '),
  };
}

function calcConfigured(name){
  const m=CONFIGURED[name];
  const flags={...m};
  if(m.blade){
    flags.bladeRatio=(m.bladeBase||15)/(m.totalBase||m.d||1);
  }
  return {base:m.d||0,oc:m.oc,flags,label:name};
}

function applyRupture(room,p,oc){
  if(oc<=effectiveOutput(p)) return {rupture:false,overreach:false};

  const excess=oc-effectiveOutput(p);
  p.ruptureStrain+=excess;
  p.gainedStrainThisRound=true;
  p.safeRounds=0;

  while(p.ruptureStrain>=2){
    p.ruptureStrain-=2;
    p.ruptureChain++;
    p.rupturedThisRound=true;
    const damage=40*(2**(p.ruptureChain-1));
    p.hp-=damage;
    log(room,`${p.name} triggers Rupture ${p.ruptureChain} and takes D${damage}.`);
  }

  return {rupture:true,overreach:excess>=3};
}

function requestRoll(room,p,label,done){
  if(p.isAI){
    const roll=1+Math.floor(Math.random()*4);
    log(room,`${p.name} virtual d4 → ${roll}.`);
    done(roll);
    return;
  }

  room.phase='roll';
  room.pending={
    kind:'roll',playerId:p.id,label,diceMode:room.settings.diceMode,
    resolve:done,
  };
  emitRoom(room);
}

function resolveConfiguration(room,p,calc,done){
  const rupture=applyRupture(room,p,calc.oc);
  const unstable=calc.oc>effectiveStability(p)||rupture.rupture;
  const stabilized=p.stabilize && calc.oc<=effectiveOutput(p) && calc.oc>effectiveStability(p);

  if(stabilized){
    p.stabilize=false;
    done({...calc,damage:Math.round(calc.base/5)*5,roll:null,overreach:false});
    return;
  }

  if(!unstable){
    done({...calc,damage:Math.round(calc.base/5)*5,roll:null,overreach:false});
    return;
  }

  requestRoll(room,p,calc.label,(roll)=>{
    const mult=roll===1?0:roll===2?.5:roll===3?1:1.2;
    done({
      ...calc,
      damage:Math.round((calc.base*mult)/5)*5,
      roll,
      overreach:rupture.overreach,
    });
  });
}

function canCounter(p){
  return p.alive && p.skipTurns===0 && (
    p.hand.some(n=>CONFIGURED[n]&&!CONFIGURED[n].shell) ||
    p.hand.some(n=>RAW[n]?.kind==='Essence')
  );
}

function aiAttackIndices(p){
  let i=p.hand.findIndex(n=>CONFIGURED[n]&&!CONFIGURED[n].shell);
  if(i>=0) return [i];

  const e=p.hand.findIndex(n=>RAW[n]?.kind==='Essence');
  if(e<0) return null;

  const idx=[e];
  const f=p.hand.findIndex((n,j)=>j!==e&&RAW[n]?.kind==='Form');
  if(f>=0) idx.push(f);

  const x=p.hand.findIndex((n,j)=>!idx.includes(j)&&RAW[n]?.kind==='Force');
  if(x>=0) idx.push(x);

  return idx;
}

function requestCounter(room,attacker,defender,attackResult,after){
  if(!canCounter(defender)){ after(null); return; }

  if(defender.isAI){
    const idx=aiAttackIndices(defender);
    if(!idx){ after(null); return; }
    performCounter(room,defender,attacker,idx,after);
    return;
  }

  room.phase='counter';
  room.pending={
    kind:'counter',
    playerId:defender.id,
    attackerId:attacker.id,
    defenderId:defender.id,
    label:`Counter ${attacker.name}'s ${attackResult.label}`,
    after,
  };
  emitRoom(room);
}

function performCounter(room,defender,attacker,indices,after){
  const valid=validateIndices(defender,indices);
  if(!valid){ after(null); return; }

  const names=namesAt(defender,valid);
  const info=analyzeSelection(names);
  if(info.error||!['Raw','Configured'].includes(info.type)){ after(null); return; }

  consumeIndices(room,defender,valid);
  const calc=info.type==='Raw'?calcRaw(names):calcConfigured(info.name);

  resolveConfiguration(room,defender,calc,(result)=>{
    log(room,`${defender.name} counters with ${result.label}: D${result.damage}${result.roll?` • d4 ${result.roll}`:''}.`);
    after(result);
  });
}

function playerEntity(p){ return {type:'player',player:p}; }
function monsterEntity(p){ return {type:'monster',owner:p}; }

function addLingeringToEntity(entity,effect){
  if(entity?.type==='player') entity.player.lingering.push({...effect});
}

function hurtEntity(room,entity,damage,label=''){
  if(!entity||damage<=0) return;

  if(entity.type==='player'){
    entity.player.hp-=damage;
    log(room,`${entity.player.name} takes D${damage}${label?` ${label}`:''}.`);
    return;
  }

  const owner=entity.owner;
  if(!owner.monster) return;
  const name=owner.monster.name;
  owner.monster.hp-=damage;
  log(room,`${owner.name}'s ${name} takes D${damage}${label?` ${label}`:''}.`);
  if(owner.monster.hp<=0){
    log(room,`${owner.name}'s ${name} is defeated.`);
    owner.monster=null;
  }
}

function applyBarrier(room,attackerEntity,target,damage,flags,sourcePlayer){
  if(!target.barrier||flags.phase) return damage;

  const barrierName=target.barrier.name;
  const b=BARRIERS[barrierName];
  let d=damage;

  if(b.reduce) d=Math.max(0,d-b.reduce);
  if(b.projectileReduce&&flags.form==='Projectile') d=Math.max(0,d-b.projectileReduce);

  const before=target.barrier.hp;
  const hit=Math.min(before,d);
  target.barrier.hp-=hit;
  d-=hit;

  // Any attacker that hits a retaliating Barrier gets hit.
  let retaliation=b.retaliate||0;
  if(target.barrier.hp<=0&&b.breakRetaliate) retaliation=b.breakRetaliate;
  if(retaliation) hurtEntity(room,attackerEntity,retaliation,'from Barrier retaliation');

  if(b.corrodeAttacker){
    addLingeringToEntity(attackerEntity,{kind:'Corrosion',damage:10,turns:2});
  }

  if(b.inferno){
    hurtEntity(room,attackerEntity,10,'from Inferno Barrier');
    addLingeringToEntity(attackerEntity,{kind:'Burn',damage:10,turns:1});
  }

  if(target.barrier.hp<=0){
    target.barrier=null;
    log(room,`${target.name}'s ${barrierName} breaks.`);

    if(b.onBreak==='freeze'&&sourcePlayer) sourcePlayer.skipTurns=Math.max(sourcePlayer.skipTurns,1);

    if(b.onBreak==='storm'){
      hurtEntity(room,attackerEntity,20,'from Storm Barrier break');
      if(attackerEntity.type==='player') attackerEntity.player.skipTurns=Math.max(attackerEntity.player.skipTurns,1);
    }

    if(b.onBreak==='stabilityDown'&&sourcePlayer){
      sourcePlayer.tempStability-=2;
    }
  }

  return d;
}

function hitMonsterGuard(room,sourcePlayer,target,damage,originalDamage,sourceType){
  if(damage<=0||!target.monster) return damage;

  const monsterName=target.monster.name;
  const m=MONSTERS[monsterName];

  const guardPotential=Math.round(originalDamage*m.guard);
  const intercept=Math.min(damage,guardPotential);
  const absorbCapacity=target.monster.hp+(m.mitigation||0);
  const absorbed=Math.min(intercept,absorbCapacity);
  const hpDamage=Math.max(0,absorbed-(m.mitigation||0));

  target.monster.hp-=hpDamage;
  damage-=absorbed;
  log(room,`${target.name}'s ${monsterName} Guards D${absorbed}.`);

  if(monsterName==='Stormclaw'&&target.monster.hp>0&&hpDamage>0){
    target.monster.charge=1;
  }

  if(monsterName==='Emberhide'&&target.monster.hp>0&&hpDamage>0&&sourceType==='configuration'){
    sourcePlayer.hp-=10;
    log(room,`${target.name}'s Emberhide retaliates D10 to ${sourcePlayer.name}.`);
  }

  if(target.monster.hp<=0){
    log(room,`${target.name}'s ${monsterName} is defeated.`);
    target.monster=null;
  }

  return damage;
}

function applyDefense(room,sourcePlayer,target,damage,flags,sourceType,done){
  if(damage<=0){ done(false); return; }

  const original=damage;
  let d=damage;

  if(!flags.phase){
    if(flags.blade&&target.barrier){
      // Exact Blade component split, based on actual Blade/Form contribution.
      const ratio=clamp(flags.bladeRatio||0,0,1);
      const barrierPart=Math.round((d*ratio)/5)*5;
      const penetratingPart=Math.max(0,d-barrierPart);
      const barrierRemainder=applyBarrier(
        room,playerEntity(sourcePlayer),target,barrierPart,flags,sourcePlayer
      );
      d=penetratingPart+barrierRemainder;
    }else{
      d=applyBarrier(room,playerEntity(sourcePlayer),target,d,flags,sourcePlayer);
    }
  }

  if(d>0&&target.monster&&!flags.phase){
    d=hitMonsterGuard(room,sourcePlayer,target,d,original,sourceType);
  }

  let reached=false;
  if(d>0){
    target.hp-=d;
    reached=true;
    log(room,`${target.name} takes D${d} player damage.`);
  }

  done(reached);
}

function applyStatusOnPlayer(target,result){
  const f=result.flags||{};
  if(f.stun||f.freeze||f.bind) target.skipTurns=Math.max(target.skipTurns,1);
  if(f.corrode) target.lingering.push({kind:'Corrosion',damage:10,turns:2});
  if(f.burn) target.lingering.push({kind:'Burn',damage:10,turns:2});
  if(f.coat&&f.essences?.includes('Fire')) target.lingering.push({kind:'Burn',damage:10,turns:2});
  if(f.coat&&f.essences?.includes('Acid')) target.lingering.push({kind:'Corrosion',damage:10,turns:2});
}

function applyNormalState(p,pick){
  if(pick==='v'){ p.maxHp+=50;p.hp+=50; }
  else if(pick==='o') p.output++;
  else if(pick==='s') p.stability++;
}

function awardStrike(room,p,done){
  p.strikes++;

  if(p.strikes<5){ done(); return; }
  p.strikes-=5;

  if(p.isAI){
    const pick=['v','o','s'][Math.floor(Math.random()*3)];
    applyNormalState(p,pick);
    log(room,`${p.name} earns a Normal State.`);
    done();
    return;
  }

  room.phase='state_choice';
  room.pending={
    kind:'state_choice',playerId:p.id,label:'Choose a Normal State',
    resolve:(pick)=>{ applyNormalState(p,pick); done(); },
  };
  emitRoom(room);
}

function applyLoss(room,p,done){
  p.lossStreak++;

  if(p.lossStreak<3){ done(); return; }
  p.lossStreak=0;

  if(p.isAI){
    if(p.hand.length>=2){
      recycle(room,p.hand.splice(-2));
      log(room,`${p.name} returns 2 cards after 3 consecutive Losses.`);
    }else{
      p.maxHp=Math.max(20,p.maxHp-100);
      p.hp=Math.min(p.hp,p.maxHp);
      log(room,`${p.name} sacrifices Core Vitality.`);
    }
    done();
    return;
  }

  room.phase='loss_choice';
  room.pending={
    kind:'loss_choice',playerId:p.id,label:'3 consecutive Losses',
    resolve:(choice)=>{
      if(choice==='cards'&&p.hand.length>=2) recycle(room,p.hand.splice(-2));
      else{
        p.maxHp=Math.max(20,p.maxHp-100);
        p.hp=Math.min(p.hp,p.maxHp);
      }
      done();
    },
  };
  emitRoom(room);
}

function registerPlayerHit(room,source,target,sourceType,done){
  // Lingering does not create Losses. Monster direct damage does.
  applyLoss(room,target,()=>{
    if(sourceType==='configuration') awardStrike(room,source,done);
    else done();
  });
}
function resetLossOnSuccess(p){ p.lossStreak=0; }

function eliminate(room,p){
  if(!p.alive) return;
  p.alive=false;
  p.hp=0;
  p.monster=null;
  p.barrier=null;
  p.lingering=[];
  p.skipTurns=0;
  log(room,`${p.name} is eliminated.`);
}

function checkEndState(room,involved,done){
  for(const p of room.players){
    if(p.alive&&p.hp<=0) eliminate(room,p);
  }

  const alive=alivePlayers(room);

  if(alive.length===1){
    room.status='ended';
    room.phase='ended';
    room.pending=null;
    log(room,`${alive[0].name} wins Echo Clash.`);
    emitRoom(room);
    return;
  }

  if(alive.length===0){
    const tied=[...new Map((involved||[]).filter(Boolean).map(p=>[p.id,p])).values()];
    for(const p of tied){
      p.alive=true;
      p.hp=20;
      p.monster=null;
      p.barrier=null;
      p.lingering=[];
      p.skipTurns=0;
      p.lossStreak=0;
      p.tempOutput=0;
      p.tempStability=0;
      p.stabilize=false;
    }

    room.tieBreaker=true;
    room.status='playing';
    room.phase='action';
    room.pending=null;
    room.round++;
    room.turnIndex=room.players.findIndex(p=>p.alive);
    log(room,`TIE BREAKER: ${tied.map(p=>p.name).join(' & ')} return at 20 HP.`);
    beginTurn(room);
    return;
  }

  done();
}

function hasBurn(target){
  return target.lingering.some(e=>e.kind==='Burn');
}

function monsterAutoAttack(room,owner,target,done){
  if(!owner.monster||!target.alive){ done(); return; }

  const monsterName=owner.monster.name;
  const m=MONSTERS[monsterName];
  let damage=m.atk;

  if(monsterName==='Ashfang'&&hasBurn(target)) damage+=10;

  if(monsterName==='Stormclaw'&&owner.monster.charge){
    damage+=10;
    owner.monster.charge=0;
  }

  log(room,`${owner.name}'s ${monsterName} attacks ${target.name} for D${damage}.`);

  let d=damage;
  if(target.barrier){
    d=applyBarrier(room,monsterEntity(owner),target,d,{},owner);
  }

  if(!owner.monster){
    checkEndState(room,[owner,target],done);
    return;
  }

  if(d>0&&target.monster){
    const def=MONSTERS[target.monster.name];
    const guard=Math.min(d,Math.round(d*def.guard));
    const capacity=target.monster.hp+(def.mitigation||0);
    const absorbed=Math.min(guard,capacity);
    const hpDamage=Math.max(0,absorbed-(def.mitigation||0));
    const targetMonsterName=target.monster.name;

    target.monster.hp-=hpDamage;
    d-=absorbed;

    if(targetMonsterName==='Stormclaw'&&target.monster.hp>0&&hpDamage>0){
      target.monster.charge=1;
    }

    if(target.monster.hp<=0){
      log(room,`${target.name}'s ${targetMonsterName} is defeated.`);
      target.monster=null;
    }
  }

  if(d>0){
    target.hp-=d;
    log(room,`${target.name} takes D${d} from ${monsterName}.`);

    if(monsterName==='Rotcrawler'&&target.lingering.length){
      const rotStacks=target.lingering.filter(e=>e.kind==='Rotcrawler').length;
      if(rotStacks<2) target.lingering.push({kind:'Rotcrawler',damage:10,turns:1});
    }

    registerPlayerHit(room,owner,target,'monster',()=>{
      checkEndState(room,[owner,target],done);
    });
  }else done();
}

function finishAttackOpportunity(room,owner,opponent,result,done){
  const afterOverreach=()=>{
    if(owner.hp<=0||opponent.hp<=0){
      checkEndState(room,[owner,opponent],done);
      return;
    }

    // Monster follows its owner's next attack opportunity, including Counter.
    if(owner.monster) monsterAutoAttack(room,owner,opponent,done);
    else done();
  };

  if(result?.overreach){
    owner.hp-=300;
    log(room,`${owner.name} suffers D300 Critical Overreach.`);
  }

  afterOverreach();
}

/*
Seat-adjacent multiplayer area rule:
- Primary target is always affected.
- Immediate left/right seats of the primary target are also affected.
- Attacker is excluded from their own area.
- Dead players are skipped as victims, but adjacency is based on fixed seats.
Thus:
2 players: primary target only.
3 players: primary target + the one other non-attacker.
4+ players: primary target + up to two side players.
Only the PRIMARY target may Counter.
*/
function sideTargets(room,attacker,primary){
  const n=room.players.length;
  const i=room.players.findIndex(p=>p.id===primary.id);
  if(i<0||n<2) return [];

  const candidateIdx=[(i-1+n)%n,(i+1)%n];
  const seen=new Set();
  const out=[];

  for(const idx of candidateIdx){
    const p=room.players[idx];
    if(!p||!p.alive||p.id===attacker.id||p.id===primary.id||seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }

  return out;
}

function isAreaAttack(result){
  const f=result.flags||{};
  if(f.wave) return true;
  if(f.burst&&result.roll===4) return true;
  if(f.ricochet&&result.damage>0) return true;
  return false;
}

function sideDamageFor(result){
  const f=result.flags||{};
  if(f.ricochet){
    if(result.roll===1) return 0;
    if(result.roll===2) return 15;
    if(result.roll===4) return 30;
    return 25; // Stable or roll 3
  }
  return result.damage;
}

function resolveSideAreaHits(room,attacker,primary,attackResult,done){
  if(!isAreaAttack(attackResult)){ done(); return; }

  const sides=sideTargets(room,attacker,primary);
  if(!sides.length){ done(); return; }

  const damage=sideDamageFor(attackResult);
  if(damage<=0){ done(); return; }

  log(room,`${attackResult.label} spreads to ${sides.map(p=>p.name).join(' & ')}. Side players cannot Counter.`);

  let index=0;
  const next=()=>{
    if(index>=sides.length){ done(); return; }
    const target=sides[index++];

    // Side lanes use the original attack result and resolve their own defenses.
    applyDefense(room,attacker,target,damage,attackResult.flags,'configuration',(reached)=>{
      if(reached){
        applyStatusOnPlayer(target,attackResult);
        registerPlayerHit(room,attacker,target,'configuration',()=>{
          checkEndState(room,[attacker,primary,...sides],next);
        });
      }else{
        checkEndState(room,[attacker,primary,...sides],next);
      }
    });
  };
  next();
}

function resolvePrimaryClash(room,attacker,defender,attackResult,counterResult,done){
  const A=attackResult.damage;
  const C=counterResult?counterResult.damage:0;

  if(counterResult){
    if(A===C){
      log(room,`Clash nullified: D${A} vs D${C}.`);
      done({primaryReached:false,counterReached:false});
      return;
    }

    if(A>C){
      resetLossOnSuccess(attacker);
      const residual=A-C;
      log(room,`${attacker.name} wins Clash. Residual D${residual} → ${defender.name}.`);

      applyDefense(room,attacker,defender,residual,attackResult.flags,'configuration',(reached)=>{
        if(reached){
          applyStatusOnPlayer(defender,attackResult);
          registerPlayerHit(room,attacker,defender,'configuration',()=>{
            done({primaryReached:true,counterReached:false});
          });
        }else done({primaryReached:false,counterReached:false});
      });
      return;
    }

    resetLossOnSuccess(defender);
    const residual=C-A;
    log(room,`${defender.name} wins Counter Clash. Residual D${residual} → ${attacker.name}.`);

    applyDefense(room,defender,attacker,residual,counterResult.flags,'configuration',(reached)=>{
      if(reached){
        applyStatusOnPlayer(attacker,counterResult);
        registerPlayerHit(room,defender,attacker,'configuration',()=>{
          done({primaryReached:false,counterReached:true});
        });
      }else done({primaryReached:false,counterReached:false});
    });
    return;
  }

  resetLossOnSuccess(attacker);
  applyDefense(room,attacker,defender,A,attackResult.flags,'configuration',(reached)=>{
    if(reached){
      applyStatusOnPlayer(defender,attackResult);
      registerPlayerHit(room,attacker,defender,'configuration',()=>{
        done({primaryReached:true,counterReached:false});
      });
    }else done({primaryReached:false,counterReached:false});
  });
}

function resolveAttackSequence(room,attacker,primary,attackResult,counterResult,done){
  /*
  The primary target's Counter only changes the PRIMARY lane.
  Area side lanes still resolve independently from the original attack.
  Side victims never receive Counter prompts.
  */
  resolvePrimaryClash(room,attacker,primary,attackResult,counterResult,()=>{
    resolveSideAreaHits(room,attacker,primary,attackResult,()=>{
      const afterCounterOpportunity=()=>{
        finishAttackOpportunity(room,attacker,primary,attackResult,done);
      };

      if(counterResult){
        // Counter is an attack opportunity, so defender's active Monster follows attacker.
        finishAttackOpportunity(room,primary,attacker,counterResult,afterCounterOpportunity);
      }else afterCounterOpportunity();
    });
  });
}

function commitAttack(room,attacker,target,indices,scheduled=true){
  const valid=validateIndices(attacker,indices);
  if(!valid) return false;

  const names=namesAt(attacker,valid);
  const info=analyzeSelection(names);
  if(info.error||!['Raw','Configured'].includes(info.type)) return false;

  consumeIndices(room,attacker,valid);
  const calc=info.type==='Raw'?calcRaw(names):calcConfigured(info.name);

  room.phase='resolution';
  resolveConfiguration(room,attacker,calc,(attackResult)=>{
    log(room,`${attacker.name} attacks ${target.name} with ${attackResult.label}: D${attackResult.damage}${attackResult.roll?` • d4 ${attackResult.roll}`:''}.`);

    requestCounter(room,attacker,target,attackResult,(counterResult)=>{
      resolveAttackSequence(room,attacker,target,attackResult,counterResult,()=>{
        checkEndState(room,[attacker,target,...sideTargets(room,attacker,target)],()=>{
          room.pending=null;
          room.phase='action';
          if(scheduled) advanceTurn(room);
          else emitRoom(room);
        });
      });
    });
  });

  return true;
}

function playUtility(room,p,indices){
  const valid=validateIndices(p,indices);
  if(!valid) return false;

  const names=namesAt(p,valid);
  const info=analyzeSelection(names);
  if(info.error||names.length!==1) return false;

  const name=names[0];
  const m=ALL[name];

  if(info.type==='Monster'){
    consumeIndices(room,p,valid);
    p.monster={name,hp:m.hp,charge:0};
    log(room,`${p.name} summons ${name}. It will attack on ${p.name}'s next attack opportunity.`);
    advanceTurn(room);
    return true;
  }

  if(info.type==='Barrier'){
    consumeIndices(room,p,valid);

    // Replacing a Barrier simply removes the old Barrier.
    if(p.barrier){
      log(room,`${p.name}'s ${p.barrier.name} is replaced.`);
      p.barrier=null;
    }

    resolveConfiguration(room,p,{base:m.hp,oc:m.oc,flags:{barrier:true},label:name},(result)=>{
      if(result.damage>0){
        p.barrier={name,hp:result.damage};
        log(room,`${p.name} deploys ${name} at ${result.damage} HP.`);
      }else log(room,`${p.name}'s ${name} fails to form.`);

      if(result.overreach){
        p.hp-=300;
        log(room,`${p.name} suffers D300 Critical Overreach.`);
      }

      checkEndState(room,[p],()=>advanceTurn(room));
    });
    return true;
  }

  if(info.type==='Support'){
    consumeIndices(room,p,valid);

    if(name==='Heal') p.hp=Math.min(p.maxHp,p.hp+50);
    else if(name==='Stability Boost') p.tempStability+=2;
    else if(name==='Output Boost') p.tempOutput+=2;
    else if(name==='Monster Heal'&&p.monster){
      p.monster.hp=Math.min(MONSTERS[p.monster.name].hp,p.monster.hp+80);
    }
    else if(name==='Cleanse'){
      p.lingering=[];
      p.skipTurns=0;
      if(p.tempStability<0) p.tempStability=0;
    }
    else if(name==='Stabilize') p.stabilize=true;

    log(room,`${p.name} uses ${name}.`);
    advanceTurn(room);
    return true;
  }

  return false;
}

function aiTurn(room,p){
  if(room.status!=='playing'||room.players[room.turnIndex]?.id!==p.id||room.pending) return;

  let i=p.hand.indexOf('Heal');
  if(p.hp<Math.min(150,p.maxHp*.4)&&i>=0){ playUtility(room,p,[i]); return; }

  if(!p.barrier){
    i=p.hand.findIndex(n=>BARRIERS[n]);
    if(i>=0){ playUtility(room,p,[i]); return; }
  }

  if(!p.monster){
    i=p.hand.findIndex(n=>MONSTERS[n]);
    if(i>=0){ playUtility(room,p,[i]); return; }
  }

  const targets=alivePlayers(room)
    .filter(x=>x.id!==p.id)
    .sort((a,b)=>(a.hp+(a.barrier?.hp||0))-(b.hp+(b.barrier?.hp||0)));

  const target=targets[0];
  if(!target) return;

  i=p.hand.findIndex(n=>CONFIGURED[n]&&!CONFIGURED[n].shell);
  if(i>=0){ commitAttack(room,p,target,[i],true); return; }

  const raw=aiAttackIndices(p);
  if(raw){ commitAttack(room,p,target,raw,true); return; }

  drawCards(room,p,3);
  log(room,`${p.name} uses Draw Action (+3).`);
  advanceTurn(room);
}

function act(room,p,action,socket){
  if(room.status!=='playing') return gameError(socket,'Match is not running.');
  if(room.pending) return gameError(socket,'A resolution is waiting.');
  if(room.players[room.turnIndex]?.id!==p.id) return gameError(socket,'Not your scheduled turn.');
  if(!p.alive) return gameError(socket,'You are eliminated.');

  if(action.type==='pass'){
    log(room,`${p.name} passes.`);
    advanceTurn(room);
    return;
  }

  if(action.type==='draw'){
    drawCards(room,p,3);
    log(room,`${p.name} uses Draw Action (+3).`);
    advanceTurn(room);
    return;
  }

  if(action.type==='trade'){
    const valid=validateIndices(p,action.indices);
    if(!valid||![3,5].includes(valid.length)) return gameError(socket,'Trade exactly 3 or 5 selected cards.');

    const drawCount=valid.length===5?3:1;
    consumeIndices(room,p,valid);
    drawCards(room,p,drawCount);
    log(room,`${p.name} trades ${valid.length} cards for ${drawCount}.`);
    advanceTurn(room);
    return;
  }

  const valid=validateIndices(p,action.indices);
  if(!valid) return gameError(socket,'Select card(s).');

  const info=analyzeSelection(namesAt(p,valid));
  if(info.error) return gameError(socket,info.error);

  if(['Raw','Configured'].includes(info.type)){
    const target=playerById(room,action.targetId);
    if(!target||!target.alive||target.id===p.id) return gameError(socket,'Choose a living opponent.');
    if(!commitAttack(room,p,target,valid,true)) gameError(socket,'Illegal attack.');
    return;
  }

  if(!playUtility(room,p,valid)) gameError(socket,'Illegal Action.');
}

function clearPending(room){
  room.pending=null;
  room.phase='resolution';
}

io.on('connection',(socket)=>{
  socket.on('create_room',(data,ack)=>{
    const room=makeRoom(
      data?.name,
      data?.totalSeats,
      data?.aiSeats,
      data?.diceMode,
      data?.disconnectMode
    );

    const host=room.players[0];
    host.socketId=socket.id;
    socket.join(room.code);

    log(room,`${host.name} created the room.`);
    ack?.({ok:true,code:room.code,token:host.token,playerId:host.id});
    emitRoom(room);
  });

  socket.on('join_room',(data,ack)=>{
    const code=String(data?.code||'').toUpperCase();
    const room=rooms.get(code);
    if(!room) return ack?.({ok:false,error:'Room not found.'});

    if(data?.token){
      const existing=room.players.find(p=>p.token===data.token&&!p.isAI);
      if(existing){
        existing.socketId=socket.id;
        existing.connected=true;
        socket.join(code);
        log(room,`${existing.name} reconnected.`);
        ack?.({ok:true,code,token:existing.token,playerId:existing.id,reconnected:true});
        emitRoom(room);
        return;
      }
    }

    if(room.status!=='lobby') return ack?.({ok:false,error:'Match already started.'});
    if(room.players.length>=room.settings.totalSeats) return ack?.({ok:false,error:'Room is full.'});

    const p=makePlayer(data?.name||`Player ${room.players.length+1}`,false);
    p.socketId=socket.id;
    p.connected=true;
    room.players.push(p);
    socket.join(code);

    log(room,`${p.name} joined.`);
    ack?.({ok:true,code,token:p.token,playerId:p.id});
    emitRoom(room);
  });

  socket.on('ready',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room) return;
    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p) return;

    p.ready=!!data.ready;
    emitRoom(room);
  });

  socket.on('start_game',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room) return;

    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p||p.id!==room.hostId) return gameError(socket,'Only host can start.');
    if(!allReady(room)) return gameError(socket,'All seats must be filled and human players ready.');

    startGame(room);
    emitRoom(room);
  });

  socket.on('act',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room) return;

    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p) return;

    act(room,p,data.action||{},socket);
    emitRoom(room);
  });

  socket.on('counter',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room||room.pending?.kind!=='counter') return;

    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p||p.id!==room.pending.playerId) return;

    const pending=room.pending;
    clearPending(room);

    if(data?.decline){
      log(room,`${p.name} declines Counter.`);
      pending.after(null);
      return;
    }

    const valid=validateIndices(p,data?.indices);
    if(!valid){
      room.pending=pending;
      room.phase='counter';
      emitRoom(room);
      gameError(socket,'Select a legal Counter or decline.');
      return;
    }

    performCounter(room,p,playerById(room,pending.attackerId),valid,pending.after);
  });

  socket.on('roll',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room||room.pending?.kind!=='roll') return;

    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p||p.id!==room.pending.playerId) return;

    const pending=room.pending;
    clearPending(room);

    let roll;
    if(pending.diceMode==='virtual') roll=1+Math.floor(Math.random()*4);
    else roll=Number(data?.roll);

    if(![1,2,3,4].includes(roll)){
      room.pending=pending;
      room.phase='roll';
      emitRoom(room);
      gameError(socket,'Enter d4 result 1–4.');
      return;
    }

    log(room,`${p.name} d4 → ${roll}.`);
    pending.resolve(roll);
  });

  socket.on('state_choice',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room||room.pending?.kind!=='state_choice'||!['v','o','s'].includes(data?.pick)) return;

    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p||p.id!==room.pending.playerId) return;

    const pending=room.pending;
    clearPending(room);
    pending.resolve(data.pick);
  });

  socket.on('loss_choice',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room||room.pending?.kind!=='loss_choice'||!['cards','vitality'].includes(data?.choice)) return;

    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p||p.id!==room.pending.playerId) return;

    const pending=room.pending;
    clearPending(room);
    pending.resolve(data.choice);
  });

  socket.on('replace_ai',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room) return;

    const host=room.players.find(x=>x.socketId===socket.id);
    if(!host||host.id!==room.hostId) return;

    const p=playerById(room,data?.playerId);
    if(!p||p.isAI) return;

    p.isAI=true;
    p.connected=true;
    p.socketId=null;
    p.ready=true;
    p.name=`AI ${p.name}`;
    log(room,`${p.name} is now AI-controlled.`);

    if(room.status==='playing'&&room.players[room.turnIndex]?.id===p.id&&!room.pending){
      setTimeout(()=>aiTurn(room,p),150);
    }
    emitRoom(room);
  });

  socket.on('disconnect',()=>{
    for(const room of rooms.values()){
      const p=room.players.find(x=>x.socketId===socket.id);
      if(!p) continue;

      p.connected=false;
      p.socketId=null;
      log(room,`${p.name} disconnected.`);

      if(room.hostId===p.id){
        const nextHost=room.players.find(x=>!x.isAI&&x.connected&&x.id!==p.id);
        if(nextHost){
          room.hostId=nextHost.id;
          log(room,`${nextHost.name} is now host.`);
        }
      }

      if(
        room.status==='playing' &&
        room.players[room.turnIndex]?.id===p.id &&
        !room.pending &&
        room.settings.disconnectMode==='autopass'
      ){
        log(room,`${p.name} auto-passes while offline.`);
        advanceTurn(room);
      }

      emitRoom(room);
    }
  });
});

setInterval(()=>{
  const now=Date.now();
  for(const [code,room] of rooms){
    if(now-room.createdAt>12*60*60*1000 && room.players.every(p=>!p.connected&&!p.isAI)){
      rooms.delete(code);
    }
  }
},60_000);

httpServer.listen(PORT,()=>console.log(`Echo Clash Online V0.4.1 listening on :${PORT}`));
