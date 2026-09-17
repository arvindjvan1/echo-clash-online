
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
const AI_TURN_DELAY_MS = 4000;
const AI_COUNTER_DELAY_MS = 1800;
const AI_ROLL_DELAY_MS = 900;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, version: '0.5.1-alpha' }));

const rooms = new Map();
const disconnectTimers = new Map();

const {RAW,CONFIGURED,MONSTERS,BARRIERS,SUPPORT,ALL,CARD_NAMES,publicCatalog}=require('./cards');
const {clamp,round5,hpForPlayers,decksForPlayers,areaSeatIndices,calcRaw,calcRawBarrier,calcConfigured,isArea,sideDamage,clashElementalAdjusted}=require('./rules');

app.get('/api/cards', (_req,res)=>res.json(publicCatalog()));

const id = (prefix='x') => `${prefix}_${crypto.randomBytes(7).toString('hex')}`;

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


function makePlayer(name,isAI=false){
  return {
    id:id('p'), token:id('tok'), name:(name||'Player').slice(0,24),
    isAI, connected:isAI, socketId:null, ready:isAI, alive:true,

    hand:[], hp:300, maxHp:300,
    output:5, stability:3,
    tempOutput:0, tempStability:0, tempStabilityPenalty:0,
    tempOutputExpireAt:null, tempStabilityExpireAt:null, stabilityPenaltyRounds:0,
    stabilize:false, shell:null, scheduledActionsCompleted:0,

    strikes:0, lossStreak:0, lastLossTurnSerial:null,
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
    round:1, turnIndex:0, turnSerial:0, phase:'lobby', pending:null,
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
  return Math.max(0,p.stability+p.tempStability-p.tempStabilityPenalty+(p.monster&&MONSTERS[p.monster.name]?.stabilityBonus||0));
}
function socketFor(p){ return p.socketId ? io.sockets.sockets.get(p.socketId) : null; }

function publicPlayer(p,viewerId){
  return {
    id:p.id,name:p.name,isAI:p.isAI,connected:p.connected,ready:p.ready,alive:p.alive,
    hp:p.hp,maxHp:p.maxHp,output:p.output,stability:p.stability,
    effectiveOutput:effectiveOutput(p),effectiveStability:effectiveStability(p),
    strikes:p.strikes,lossStreak:p.lossStreak,ruptureStrain:p.ruptureStrain,
    handCount:p.hand.length,hand:p.id===viewerId?p.hand:undefined,
    monster:p.monster,barrier:p.barrier,shell:p.shell,lingering:p.lingering,skipTurns:p.skipTurns,
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
  let drawn=0;
  for(let i=0;i<n && p.hand.length<15;i++){
    const card=drawOne(room);
    if(card){p.hand.push(card);drawn++;}
  }
  return drawn;
}
function recycle(room,cards){ room.recycle.unshift(...cards); }

function allReady(room){
  return room.players.length===room.settings.totalSeats &&
    room.players.filter(p=>!p.isAI).every(p=>p.connected&&p.ready);
}

function resetPlayerForMatch(p,hp){
  Object.assign(p,{
    alive:true,hand:[],maxHp:hp,hp,
    output:5,stability:3,tempOutput:0,tempStability:0,tempStabilityPenalty:0,tempOutputExpireAt:null,tempStabilityExpireAt:null,stabilityPenaltyRounds:0,stabilize:false,shell:null,scheduledActionsCompleted:0,
    strikes:0,lossStreak:0,lastLossTurnSerial:null,ruptureStrain:0,ruptureChain:0,
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
  room.turnSerial=0;
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

    if(p.stabilityPenaltyRounds>0){
      p.stabilityPenaltyRounds--;
      if(p.stabilityPenaltyRounds<=0) p.tempStabilityPenalty=0;
    }
    p.gainedStrainThisRound=false;
    p.rupturedThisRound=false;
  }
  room.round++;
  log(room,`Round ${room.round} begins.`);
}

function endScheduledAction(room,p){
  p.scheduledActionsCompleted++;
  if(p.tempOutputExpireAt!==null && p.scheduledActionsCompleted>=p.tempOutputExpireAt){
    p.tempOutput=0;p.tempOutputExpireAt=null;
  }
  if(p.tempStabilityExpireAt!==null && p.scheduledActionsCompleted>=p.tempStabilityExpireAt){
    p.tempStability=0;p.tempStabilityExpireAt=null;
  }
  advanceTurn(room);
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

function scheduleGraceTimeout(room,p){
  const key=`${room.code}:${p.id}`;
  if(disconnectTimers.has(key)) clearTimeout(disconnectTimers.get(key));
  const timer=setTimeout(()=>{
    disconnectTimers.delete(key);
    if(p.connected||p.isAI||room.status!=='playing') return;
    if(room.pending?.playerId===p.id){
      const pending=room.pending;
      clearPending(room);
      if(pending.kind==='counter'){
        log(room,`${p.name}'s reconnect grace expired. Counter declined.`);
        pending.after(null);
      }else if(pending.kind==='roll'){
        const roll=1+Math.floor(Math.random()*4);
        log(room,`${p.name}'s reconnect grace expired. Virtual d4 → ${roll}.`);
        pending.resolve(roll);
      }
      return;
    }
    if(room.players[room.turnIndex]?.id===p.id){
      log(room,`${p.name}'s reconnect grace expired. Turn auto-passes.`);
      endScheduledAction(room,p);
    }
  },room.settings.graceMs);
  disconnectTimers.set(key,timer);
}

function beginTurn(room){
  if(room.status!=='playing') return;
  const p=room.players[room.turnIndex];

  if(!p?.alive){ advanceTurn(room); return; }
  room.turnSerial=(room.turnSerial||0)+1;

  // V0.5: every scheduled turn begins with one automatic draw, up to the 15-card hand cap.
  const turnDrawn=drawCards(room,p,1);
  if(turnDrawn) log(room,`${p.name} draws 1 card at the start of the scheduled turn.`);

  if(p.shell){ log(room,`${p.name}'s Echo Shell expires.`); p.shell=null; }

  if(p.monster?.lingering?.length){
    const keep=[];
    for(const e of p.monster.lingering){
      p.monster.hp-=e.damage;
      log(room,`${p.name}'s ${p.monster.name} suffers D${e.damage} ${e.kind}.`);
      e.turns--;
      if(e.turns>0) keep.push(e);
      if(!p.monster || p.monster.hp<=0) break;
    }
    if(p.monster){
      p.monster.lingering=keep;
      if(p.monster.hp<=0){log(room,`${p.name}'s ${p.monster.name} is defeated.`);p.monster=null;}
    }
  }

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

    if(p.hp<=0){
      const chainAliveIds=alivePlayers(room).map(x=>x.id);
      checkEndState(room,chainAliveIds,()=>advanceTurn(room));
      return;
    }
  }

  if(p.skipTurns>0){
    p.skipTurns--;
    log(room,`${p.name} is Stunned/Frozen and skips the scheduled turn.`);
    advanceTurn(room);
    return;
  }

  room.phase='action';

  if(p.isAI) setTimeout(()=>aiTurn(room,p),AI_TURN_DELAY_MS);
  else if(!p.connected && room.settings.disconnectMode==='autopass'){
    log(room,`${p.name} is disconnected and auto-passes.`);
    endScheduledAction(room,p);
    return;
  }else if(!p.connected && room.settings.disconnectMode==='grace'){
    log(room,`${p.name} is disconnected. Waiting up to 5 minutes before auto-pass.`);
    scheduleGraceTimeout(room,p);
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

  if(names.includes('Barrier Form')){
    const ess=names.filter(n=>RAW[n]?.kind==='Essence');
    const invalid=names.filter(n=>n!=='Barrier Form'&&RAW[n]?.kind!=='Essence');
    if(!ess.length) return {error:'Barrier Form needs at least one Essence.'};
    if(invalid.length) return {error:'Barrier Form can combine with Essence cards only.'};
    return {type:'RawBarrier',names};
  }

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
    setTimeout(()=>{
      const roll=1+Math.floor(Math.random()*4);
      log(room,`${p.name} virtual d4 → ${roll}.`);
      done(roll);
    },AI_ROLL_DELAY_MS);
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
    setTimeout(()=>{
      if(!idx){ after(null); return; }
      performCounter(room,defender,attacker,idx,after);
    },AI_COUNTER_DELAY_MS);
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
  else if(entity?.type==='monster'&&entity.owner.monster){
    if(!entity.owner.monster.lingering) entity.owner.monster.lingering=[];
    entity.owner.monster.lingering.push({...effect});
  }
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
  const b=BARRIERS[barrierName]||{};
  let baseDamage=damage;

  if(b.reduce) baseDamage=Math.max(0,baseDamage-b.reduce);
  if(b.projectileReduce&&flags.form==='Projectile') baseDamage=Math.max(0,baseDamage-b.projectileReduce);
  if(baseDamage<=0) return 0;

  // Earth is 20% more effective against Barriers, but only the Barrier-facing portion gets the bonus.
  const barrierMultiplier=(flags.essences||[]).includes('Earth')?1.20:1;
  const barrierIncoming=baseDamage*barrierMultiplier;
  const absorbedBarrier=Math.min(target.barrier.hp,barrierIncoming);
  target.barrier.hp-=absorbedBarrier;
  const baseSpent=absorbedBarrier/barrierMultiplier;
  let remaining=Math.max(0,baseDamage-baseSpent);

  if(absorbedBarrier>0){
    let retaliation=b.retaliate||0;
    if(target.barrier.hp<=0&&b.breakRetaliate) retaliation=b.breakRetaliate;
    if(retaliation) hurtEntity(room,attackerEntity,retaliation,'from Barrier retaliation');

    if(b.corrodeAttacker) addLingeringToEntity(attackerEntity,{kind:'Corrosion',damage:10,turns:2});
    if(b.inferno){
      hurtEntity(room,attackerEntity,10,'from Inferno Barrier');
      addLingeringToEntity(attackerEntity,{kind:'Burn',damage:10,turns:1});
    }
  }

  if(target.barrier.hp<=0){
    target.barrier=null;
    log(room,`${target.name}'s ${barrierName} breaks.`);
    if(b.onBreak==='freeze'&&sourcePlayer) sourcePlayer.skipTurns=Math.max(sourcePlayer.skipTurns,1);
    if(b.onBreak==='storm'){
      hurtEntity(room,attackerEntity,20,'from Storm Barrier break');
      if(attackerEntity.type==='player') attackerEntity.player.skipTurns=Math.max(attackerEntity.player.skipTurns,1);
      if(attackerEntity.type==='monster') attackerEntity.owner.skipTurns=Math.max(attackerEntity.owner.skipTurns,1);
    }
    if(b.onBreak==='stabilityDown'&&sourcePlayer){
      sourcePlayer.tempStabilityPenalty=Math.max(sourcePlayer.tempStabilityPenalty,2);
      sourcePlayer.stabilityPenaltyRounds=Math.max(sourcePlayer.stabilityPenaltyRounds,2);
    }
  }
  return round5(remaining);
}

function acidMonsterMultiplier(flags){ return (flags.essences||[]).includes('Acid')?1.20:1; }

function hitMonsterGuard(room,sourcePlayer,target,damage,originalDamage,sourceType,flags){
  if(damage<=0||!target.monster) return damage;
  const monsterName=target.monster.name;
  const m=MONSTERS[monsterName];
  const acidMult=acidMonsterMultiplier(flags);

  const guardPotential=Math.round(originalDamage*m.guard);
  const intercept=Math.min(damage,guardPotential);
  const mitigation=m.mitigation||0;
  // Convert Monster HP to equivalent incoming attack units when Acid is amplified against Monsters.
  const absorbCapacity=(target.monster.hp/acidMult)+mitigation;
  const absorbed=Math.min(intercept,absorbCapacity);
  const afterMitigation=Math.max(0,absorbed-mitigation);
  const hpDamage=Math.min(target.monster.hp,Math.round(afterMitigation*acidMult));

  target.monster.hp-=hpDamage;
  damage=Math.max(0,damage-absorbed);
  log(room,`${target.name}'s ${monsterName} Guards D${round5(absorbed)}${acidMult>1?' (Acid +20% vs Monster)':''}.`);

  if(monsterName==='Stormclaw'&&target.monster.hp>0&&hpDamage>0) target.monster.charge=1;
  if(monsterName==='Emberhide'&&target.monster.hp>0&&hpDamage>0&&sourceType==='configuration'){
    sourcePlayer.hp-=10;
    log(room,`${target.name}'s Emberhide retaliates D10 to ${sourcePlayer.name}.`);
  }
  if(target.monster.hp<=0){
    log(room,`${target.name}'s ${monsterName} is defeated.`);
    target.monster=null;
  }
  return round5(damage);
}

function hitShell(room,target,damage){
  if(damage<=0||!target.shell) return damage;
  const absorbed=Math.min(target.shell.hp,damage);
  target.shell.hp-=absorbed;
  damage-=absorbed;
  log(room,`${target.name}'s Echo Shell absorbs D${absorbed}.`);
  if(target.shell.hp<=0){ target.shell=null; log(room,`${target.name}'s Echo Shell breaks.`); }
  return damage;
}

function damageMonsterDirect(room,sourcePlayer,target,damage,flags,sourceType){
  if(!target.monster||damage<=0) return;
  const name=target.monster.name;
  const mult=acidMonsterMultiplier(flags);
  const hpDamage=round5(damage*mult);
  target.monster.hp-=hpDamage;
  log(room,`${target.name}'s ${name} takes D${hpDamage}${mult>1?' (Acid +20%)':''} from the Wave.`);
  if(name==='Stormclaw'&&target.monster.hp>0) target.monster.charge=1;
  if(name==='Emberhide'&&target.monster.hp>0&&sourceType==='configuration'){
    sourcePlayer.hp-=10;log(room,`${target.name}'s Emberhide retaliates D10 to ${sourcePlayer.name}.`);
  }
  if(target.monster.hp<=0){log(room,`${target.name}'s ${name} is defeated.`);target.monster=null;}
}

function applyDefense(room,sourcePlayer,target,damage,flags,sourceType,done){
  if(damage<=0){ done(false); return; }
  const original=damage;
  let d=damage;

  if(!flags.phase){
    if(flags.blade&&target.barrier){
      const ratio=clamp(flags.bladeRatio||0,0,1);
      const barrierPart=round5(d*ratio);
      const penetratingPart=Math.max(0,d-barrierPart);
      const rem=applyBarrier(room,playerEntity(sourcePlayer),target,barrierPart,flags,sourcePlayer);
      d=penetratingPart+rem;
    }else d=applyBarrier(room,playerEntity(sourcePlayer),target,d,flags,sourcePlayer);
  }

  // Wave is broad inside every affected player's field: after Barrier, it hits Monster + Player simultaneously.
  if(d>0&&flags.wave&&!flags.phase){
    if(target.monster) damageMonsterDirect(room,sourcePlayer,target,d,flags,sourceType);
  }else if(d>0&&target.monster&&!flags.phase){
    d=hitMonsterGuard(room,sourcePlayer,target,d,original,sourceType,flags);
  }

  d=hitShell(room,target,d);
  let reached=false;
  if(d>0){
    target.hp-=d;reached=true;
    log(room,`${target.name} takes D${d} player damage.`);
  }
  done(reached);
}

function applyStatusOnPlayer(room,target,result){
  const f=result.flags||{};
  if(f.stun||f.freeze) target.skipTurns=Math.max(target.skipTurns,1);
  if(f.bind){
    const targetIndex=room.players.findIndex(p=>p.id===target.id);
    // Bind stops a scheduled Action only if that seat has not acted yet this round.
    if(targetIndex>room.turnIndex) target.skipTurns=Math.max(target.skipTurns,1);
    target.lingering.push({kind:'Spike Bind',damage:5,turns:2});
  }
  if(f.corrode) target.lingering.push({kind:'Corrosion',damage:10,turns:2});
  if(f.burn) target.lingering.push({kind:'Burn',damage:10,turns:2});
  if(f.coat&&f.essences?.includes('Fire')) target.lingering.push({kind:'Burn',damage:10,turns:2});
  if(f.coat&&f.essences?.includes('Acid')) target.lingering.push({kind:'Corrosion',damage:10,turns:2});
}

function triggerEchoCollapse(room,target,result){
  if(!result.flags?.collapse||!target.lingering.length) return;
  let total=0;
  for(const e of target.lingering) total+=e.damage*e.turns;
  target.lingering=[];
  if(total>0){target.hp-=total;log(room,`Echo Collapse triggers D${total} stored lingering damage on ${target.name}.`);}
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
    applyNormalState(p,pick);log(room,`${p.name} earns a Normal State.`);done();return;
  }
  room.phase='state_choice';
  room.pending={kind:'state_choice',playerId:p.id,label:'Choose a Normal State',resolve:(pick)=>{applyNormalState(p,pick);done();}};
  emitRoom(room);
}

function availableCoreSacrifices(p){
  const out=[];
  if(p.maxHp>20) out.push('vitality');
  if(p.output>0) out.push('output');
  if(p.stability>0) out.push('stability');
  return out;
}

function sacrificeCoreState(room,p,type){
  if(type==='vitality'&&p.maxHp>20){
    p.maxHp=Math.max(20,p.maxHp-100);p.hp=Math.min(p.hp,p.maxHp);
    log(room,`${p.name} sacrifices Core Vitality: Max HP −100.`);return true;
  }
  if(type==='output'&&p.output>0){
    p.output=Math.max(0,p.output-1);
    log(room,`${p.name} sacrifices Core Output: Output −1.`);return true;
  }
  if(type==='stability'&&p.stability>0){
    p.stability=Math.max(0,p.stability-1);
    log(room,`${p.name} sacrifices Core Stability: Stability −1.`);return true;
  }
  return false;
}

function applyLoss(room,p,done){
  // A Player can gain at most one Loss during a single scheduled turn.
  // This prevents a Configuration + Monster follow-up from counting as two Losses.
  if(p.lastLossTurnSerial===room.turnSerial){ done(); return; }
  p.lastLossTurnSerial=room.turnSerial;
  p.lossStreak++;
  log(room,`${p.name} records Loss ${p.lossStreak}/3.`);
  if(p.lossStreak<3){ done(); return; }

  // The third consecutive Loss triggers one penalty, then the streak immediately resets.
  // A Loss on the next scheduled turn begins a fresh streak at 1/3.
  p.lossStreak=0;
  log(room,`${p.name} reaches 3 consecutive Losses. The Loss streak resets to 0 after this penalty.`);

  if(p.isAI){
    if(p.hand.length>=2){
      recycle(room,p.hand.splice(-2));
      log(room,`${p.name} returns 2 cards after 3 consecutive Losses.`);
    }else{
      const choices=availableCoreSacrifices(p);
      const pick=choices[Math.floor(Math.random()*choices.length)];
      if(pick) sacrificeCoreState(room,p,pick);
    }
    done();return;
  }

  room.phase='loss_choice';
  room.pending={kind:'loss_choice',playerId:p.id,label:'3 consecutive Losses • streak resets after this penalty',resolve:(choice)=>{
    if(choice?.type==='cards'){
      const idx=validateIndices(p,choice.indices);
      if(!idx||idx.length!==2) return false;
      consumeIndices(room,p,idx);
      log(room,`${p.name} returns 2 chosen cards after 3 consecutive Losses.`);
    }else if(!sacrificeCoreState(room,p,choice?.type)){
      return false;
    }
    done();return true;
  }};
  emitRoom(room);
}

function registerPlayerHit(room,source,target,sourceType,done){
  applyLoss(room,target,()=>{
    if(sourceType==='configuration') awardStrike(room,source,done);
    else done();
  });
}
function resetLossOnSuccess(p){ p.lossStreak=0; }

function eliminate(room,p){
  if(!p.alive) return;
  p.alive=false;p.hp=0;p.monster=null;p.barrier=null;p.shell=null;p.lingering=[];p.skipTurns=0;
  log(room,`${p.name} is eliminated.`);
}

function checkEndState(room,chainAliveIds,done){
  const chainIds=new Set(chainAliveIds||[]);
  const deadNow=room.players.filter(p=>p.alive&&p.hp<=0);
  for(const p of deadNow) eliminate(room,p);
  const alive=alivePlayers(room);

  if(alive.length===1){
    room.status='ended';room.phase='ended';room.pending=null;
    log(room,`${alive[0].name} wins Echo Clash.`);emitRoom(room);return;
  }
  if(alive.length===0){
    const tied=room.players.filter(p=>chainIds.has(p.id));
    for(const p of tied){
      p.alive=true;p.hp=20;p.monster=null;p.barrier=null;p.shell=null;p.lingering=[];p.skipTurns=0;
      p.lossStreak=0;p.tempOutput=0;p.tempStability=0;p.tempStabilityPenalty=0;p.stabilityPenaltyRounds=0;p.stabilize=false;
    }
    room.tieBreaker=true;room.status='playing';room.phase='action';room.pending=null;room.round++;
    room.turnIndex=room.players.findIndex(p=>p.alive);
    log(room,`TIE BREAKER: ${tied.map(p=>p.name).join(' & ')} return at 20 HP.`);
    beginTurn(room);return;
  }
  done();
}

function hasBurn(target){ return target.lingering.some(e=>e.kind==='Burn'); }

function monsterAutoAttack(room,owner,target,done){
  if(!owner.monster||!target.alive){ done(); return; }
  const monsterName=owner.monster.name,m=MONSTERS[monsterName];
  let damage=m.atk;
  if(monsterName==='Ashfang'&&hasBurn(target)) damage+=10;
  if(monsterName==='Stormclaw'&&owner.monster.charge){damage+=10;owner.monster.charge=0;}
  log(room,`${owner.name}'s ${monsterName} attacks ${target.name} for D${damage}.`);

  let d=damage;
  if(target.barrier) d=applyBarrier(room,monsterEntity(owner),target,d,{},owner);
  if(!owner.monster){done();return;}
  if(d>0&&target.monster){
    const def=MONSTERS[target.monster.name];
    const guard=Math.min(d,Math.round(d*def.guard));
    const capacity=target.monster.hp+(def.mitigation||0);
    const absorbed=Math.min(guard,capacity);
    const hpDamage=Math.max(0,absorbed-(def.mitigation||0));
    const targetMonsterName=target.monster.name;
    target.monster.hp-=hpDamage;d-=absorbed;
    if(targetMonsterName==='Stormclaw'&&target.monster.hp>0&&hpDamage>0) target.monster.charge=1;
    if(target.monster.hp<=0){log(room,`${target.name}'s ${targetMonsterName} is defeated.`);target.monster=null;}
  }
  d=hitShell(room,target,d);
  if(d>0){
    target.hp-=d;log(room,`${target.name} takes D${d} from ${monsterName}.`);
    resetLossOnSuccess(owner);
    if(monsterName==='Rotcrawler'&&target.lingering.length){
      const stacks=target.lingering.filter(e=>e.kind==='Rotcrawler').length;
      if(stacks<2) target.lingering.push({kind:'Rotcrawler',damage:10,turns:1});
    }
    registerPlayerHit(room,owner,target,'monster',done);
  }else done();
}

function finishAttackOpportunity(room,owner,opponent,result,done){
  if(result?.overreach){owner.hp-=300;log(room,`${owner.name} suffers D300 Critical Overreach.`);}
  if(owner.monster) monsterAutoAttack(room,owner,opponent,done);
  else done();
}

function sideTargets(room,attacker,primary){
  const n=room.players.length;
  const primaryIndex=room.players.findIndex(p=>p.id===primary.id);
  if(primaryIndex<0) return [];
  return areaSeatIndices(primaryIndex,n)
    .map(i=>room.players[i])
    .filter(p=>p&&p.alive&&p.id!==primary.id&&p.id!==attacker.id);
}

function resolveAreaHits(room,attacker,primary,result,done){
  if(!isArea(result)){done();return;}
  const sides=sideTargets(room,attacker,primary);
  const damage=sideDamage(result);
  if(!sides.length||damage<=0){done();return;}
  log(room,`${result.label} spreads to ${sides.map(p=>p.name).join(' & ')}. Side Players cannot Counter.`);
  let i=0;
  const next=()=>{
    if(i>=sides.length){done();return;}
    const target=sides[i++];
    applyDefense(room,attacker,target,damage,result.flags,'configuration',(reached)=>{
      if(reached){
        resetLossOnSuccess(attacker);applyStatusOnPlayer(room,target,result);triggerEchoCollapse(room,target,result);
        registerPlayerHit(room,attacker,target,'configuration',next);
      }else next();
    });
  };
  next();
}

function resolvePrimaryClash(room,attacker,defender,attackResult,counterResult,done){
  const adjusted=clashElementalAdjusted(attackResult,counterResult);
  const A=adjusted.attack,C=counterResult?adjusted.counter:0;
  if(counterResult){
    if(A===C){log(room,`Clash nullified: D${A} vs D${C}.`);done();return;}
    if(A>C){
      resetLossOnSuccess(attacker);
      const residual=A-C;log(room,`${attacker.name} wins Clash. Residual D${residual} → ${defender.name}.`);
      applyDefense(room,attacker,defender,residual,attackResult.flags,'configuration',(reached)=>{
        if(reached){applyStatusOnPlayer(room,defender,attackResult);triggerEchoCollapse(room,defender,attackResult);registerPlayerHit(room,attacker,defender,'configuration',done);}
        else done();
      });return;
    }
    resetLossOnSuccess(defender);
    const residual=C-A;log(room,`${defender.name} wins Counter Clash. Residual D${residual} → ${attacker.name}.`);
    applyDefense(room,defender,attacker,residual,counterResult.flags,'configuration',(reached)=>{
      if(reached){applyStatusOnPlayer(room,attacker,counterResult);triggerEchoCollapse(room,attacker,counterResult);registerPlayerHit(room,defender,attacker,'configuration',done);}
      else done();
    });return;
  }

  applyDefense(room,attacker,defender,A,attackResult.flags,'configuration',(reached)=>{
    if(reached){resetLossOnSuccess(attacker);applyStatusOnPlayer(room,defender,attackResult);triggerEchoCollapse(room,defender,attackResult);registerPlayerHit(room,attacker,defender,'configuration',done);}
    else done();
  });
}

function resolveAttackSequence(room,attacker,primary,attackResult,counterResult,done){
  resolvePrimaryClash(room,attacker,primary,attackResult,counterResult,()=>{
    resolveAreaHits(room,attacker,primary,attackResult,()=>{
      const counterArea=()=>{
        if(!counterResult){afterCounterMonster();return;}
        // A Counter is itself an attack. If it is an area configuration, it spreads around the original attacker.
        resolveAreaHits(room,primary,attacker,counterResult,afterCounterMonster);
      };
      const afterCounterMonster=()=>{
        if(counterResult) finishAttackOpportunity(room,primary,attacker,counterResult,afterAttackerMonster);
        else afterAttackerMonster();
      };
      const afterAttackerMonster=()=>finishAttackOpportunity(room,attacker,primary,attackResult,done);
      counterArea();
    });
  });
}

function commitAttack(room,attacker,target,indices,scheduled=true){
  const valid=validateIndices(attacker,indices);if(!valid) return false;
  const names=namesAt(attacker,valid),info=analyzeSelection(names);
  if(info.error||!['Raw','Configured'].includes(info.type)||info.name==='Echo Shell') return false;
  const chainAliveIds=alivePlayers(room).map(p=>p.id);
  consumeIndices(room,attacker,valid);
  const calc=info.type==='Raw'?calcRaw(names):calcConfigured(info.name);
  room.phase='resolution';
  resolveConfiguration(room,attacker,calc,(attackResult)=>{
    log(room,`${attacker.name} attacks ${target.name} with ${attackResult.label}: D${attackResult.damage}${attackResult.roll?` • d4 ${attackResult.roll}`:''}.`);
    requestCounter(room,attacker,target,attackResult,(counterResult)=>{
      resolveAttackSequence(room,attacker,target,attackResult,counterResult,()=>{
        checkEndState(room,chainAliveIds,()=>{
          room.pending=null;room.phase='action';
          if(scheduled) endScheduledAction(room,attacker);else emitRoom(room);
        });
      });
    });
  });
  return true;
}

function deployResolvedBarrier(room,p,name,result){
  if(p.barrier){log(room,`${p.name}'s ${p.barrier.name} is replaced.`);p.barrier=null;}
  if(result.damage>0){p.barrier={name,hp:result.damage};log(room,`${p.name} deploys ${name} at ${result.damage} HP.`);}
  else log(room,`${p.name}'s ${name} fails to form.`);
  if(result.overreach){p.hp-=300;log(room,`${p.name} suffers D300 Critical Overreach.`);}
}

function playUtility(room,p,indices){
  const valid=validateIndices(p,indices);if(!valid) return false;
  const names=namesAt(p,valid),info=analyzeSelection(names);
  if(info.error) return false;

  if(info.type==='RawBarrier'){
    consumeIndices(room,p,valid);
    const calc=calcRawBarrier(names);
    resolveConfiguration(room,p,calc,(result)=>{
      deployResolvedBarrier(room,p,calc.barrierName,result);
      checkEndState(room,[p.id],()=>endScheduledAction(room,p));
    });
    return true;
  }

  if(names.length!==1) return false;
  const name=names[0],m=ALL[name];

  if(info.type==='Monster'){
    consumeIndices(room,p,valid);p.monster={name,hp:m.hp,charge:0,lingering:[]};
    log(room,`${p.name} summons ${name}. It attacks on ${p.name}'s next attack opportunity.`);
    endScheduledAction(room,p);return true;
  }

  if(info.type==='Barrier'){
    consumeIndices(room,p,valid);
    resolveConfiguration(room,p,{base:m.hp,oc:m.oc,flags:{barrier:true},label:name},(result)=>{
      deployResolvedBarrier(room,p,name,result);
      checkEndState(room,[p.id],()=>endScheduledAction(room,p));
    });return true;
  }

  if(info.type==='Configured'&&name==='Echo Shell'){
    consumeIndices(room,p,valid);
    resolveConfiguration(room,p,{base:60,oc:m.oc,flags:{shell:true},label:name},(result)=>{
      if(result.damage>0){p.shell={hp:result.damage};log(room,`${p.name} forms Echo Shell with D${result.damage} temporary HP.`);}
      else log(room,`${p.name}'s Echo Shell fails to form.`);
      if(result.overreach){p.hp-=300;log(room,`${p.name} suffers D300 Critical Overreach.`);}
      checkEndState(room,[p.id],()=>endScheduledAction(room,p));
    });return true;
  }

  if(info.type==='Support'){
    consumeIndices(room,p,valid);
    if(name==='Heal') p.hp=Math.min(p.maxHp,p.hp+50);
    else if(name==='Stability Boost'){
      p.tempStability=2;p.tempStabilityExpireAt=p.scheduledActionsCompleted+2;
    }else if(name==='Output Boost'){
      p.tempOutput=2;p.tempOutputExpireAt=p.scheduledActionsCompleted+2;
    }else if(name==='Monster Heal'&&p.monster) p.monster.hp=Math.min(MONSTERS[p.monster.name].hp,p.monster.hp+80);
    else if(name==='Cleanse'){
      p.lingering=[];p.skipTurns=0;p.tempStabilityPenalty=0;p.stabilityPenaltyRounds=0;
    }else if(name==='Stabilize') p.stabilize=true;
    log(room,`${p.name} uses ${name}.`);endScheduledAction(room,p);return true;
  }
  return false;
}

function aiTurn(room,p){
  if(room.status!=='playing'||room.players[room.turnIndex]?.id!==p.id||room.pending) return;
  let i=p.hand.indexOf('Heal');
  if(p.hp<Math.min(150,p.maxHp*.4)&&i>=0){playUtility(room,p,[i]);return;}
  if(!p.barrier){i=p.hand.findIndex(n=>BARRIERS[n]);if(i>=0){playUtility(room,p,[i]);return;}}
  if(!p.monster){i=p.hand.findIndex(n=>MONSTERS[n]);if(i>=0){playUtility(room,p,[i]);return;}}
  if(p.hp<180){i=p.hand.indexOf('Echo Shell');if(i>=0){playUtility(room,p,[i]);return;}}

  const targets=alivePlayers(room).filter(x=>x.id!==p.id).sort((a,b)=>(a.hp+(a.barrier?.hp||0))-(b.hp+(b.barrier?.hp||0)));
  const target=targets[0];if(!target) return;
  i=p.hand.findIndex(n=>CONFIGURED[n]&&!CONFIGURED[n].shell);
  if(i>=0){commitAttack(room,p,target,[i],true);return;}
  const raw=aiAttackIndices(p);if(raw){commitAttack(room,p,target,raw,true);return;}
  const drawn=drawCards(room,p,3);
  if(drawn){log(room,`${p.name} uses Draw Action (+${drawn}).`);endScheduledAction(room,p);}
  else{log(room,`${p.name} passes with a full hand.`);endScheduledAction(room,p);}
}

function act(room,p,action,socket){
  if(room.status!=='playing') return gameError(socket,'Match is not running.');
  if(room.pending) return gameError(socket,'A resolution is waiting.');
  if(room.players[room.turnIndex]?.id!==p.id) return gameError(socket,'Not your scheduled turn.');
  if(!p.alive) return gameError(socket,'You are eliminated.');

  if(action.type==='pass'){log(room,`${p.name} passes.`);endScheduledAction(room,p);return;}
  if(action.type==='draw'){
    if(p.hand.length>=15) return gameError(socket,'Hand is full (15). Trade or play cards first.');
    const drawn=drawCards(room,p,3);log(room,`${p.name} uses Draw Action (+${drawn}).`);endScheduledAction(room,p);return;
  }
  if(action.type==='trade'){
    const valid=validateIndices(p,action.indices);
    if(!valid||![3,5].includes(valid.length)) return gameError(socket,'Trade exactly 3 cards for 1, or 5 cards for 3.');
    const drawCount=valid.length===5?3:1;
    consumeIndices(room,p,valid);const drawn=drawCards(room,p,drawCount);
    log(room,`${p.name} trades ${valid.length} cards for ${drawn}.`);endScheduledAction(room,p);return;
  }

  const valid=validateIndices(p,action.indices);if(!valid) return gameError(socket,'Select card(s).');
  const info=analyzeSelection(namesAt(p,valid));if(info.error) return gameError(socket,info.error);

  if(info.type==='RawBarrier'||(info.type==='Configured'&&info.name==='Echo Shell')||['Monster','Barrier','Support'].includes(info.type)){
    if(!playUtility(room,p,valid)) gameError(socket,'Illegal Action.');return;
  }
  if(['Raw','Configured'].includes(info.type)){
    const target=playerById(room,action.targetId);
    if(!target||!target.alive||target.id===p.id) return gameError(socket,'Choose a living opponent.');
    if(!commitAttack(room,p,target,valid,true)) gameError(socket,'Illegal attack.');return;
  }
  gameError(socket,'Illegal Action.');
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
        const timerKey=`${room.code}:${existing.id}`;
        if(disconnectTimers.has(timerKey)){clearTimeout(disconnectTimers.get(timerKey));disconnectTimers.delete(timerKey);}
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
    if(!room||room.pending?.kind!=='loss_choice'||!['cards','vitality','output','stability'].includes(data?.choice)) return;
    const p=room.players.find(x=>x.socketId===socket.id);
    if(!p||p.id!==room.pending.playerId) return;
    const pending=room.pending;
    const payload=data.choice==='cards'?{type:'cards',indices:data.indices}:{type:data.choice};
    clearPending(room);
    const ok=pending.resolve(payload);
    if(ok===false){room.pending=pending;room.phase='loss_choice';gameError(socket,'Choose an available Core State, or select exactly 2 cards to return.');emitRoom(room);return;}
  });

  socket.on('replace_ai',(data)=>{
    const room=rooms.get(String(data?.code||'').toUpperCase());
    if(!room) return;

    const host=room.players.find(x=>x.socketId===socket.id);
    if(!host||host.id!==room.hostId) return;

    const p=playerById(room,data?.playerId);
    if(!p||p.isAI) return;

    const timerKey=`${room.code}:${p.id}`;
    if(disconnectTimers.has(timerKey)){clearTimeout(disconnectTimers.get(timerKey));disconnectTimers.delete(timerKey);}
    p.isAI=true;p.connected=true;p.socketId=null;p.ready=true;p.name=`AI ${p.name}`;
    log(room,`${p.name} is now AI-controlled.`);
    if(room.pending?.playerId===p.id){
      const pending=room.pending;clearPending(room);
      if(pending.kind==='counter'){
        const idx=aiAttackIndices(p);if(idx) performCounter(room,p,playerById(room,pending.attackerId),idx,pending.after);else pending.after(null);
      }else if(pending.kind==='roll'){
        const roll=1+Math.floor(Math.random()*4);log(room,`${p.name} virtual d4 → ${roll}.`);pending.resolve(roll);
      }
    }else if(room.status==='playing'&&room.players[room.turnIndex]?.id===p.id){setTimeout(()=>aiTurn(room,p),150);}
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
        endScheduledAction(room,p);
      }else if(room.status==='playing'&&room.settings.disconnectMode==='grace'&&(room.players[room.turnIndex]?.id===p.id||room.pending?.playerId===p.id)){
        scheduleGraceTimeout(room,p);
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

httpServer.listen(PORT,()=>console.log(`Echo Clash Online V0.4.2 listening on :${PORT}`));
