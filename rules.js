'use strict';

const {RAW,CONFIGURED}=require('./cards');

const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const round5=n=>Math.round(n/5)*5;

function hpForPlayers(n){ return n>=7?500:n>=5?400:300; }
function decksForPlayers(n){ return Math.ceil(n/3); }

function areaSeatIndices(primaryIndex,total){
  if(total<2||primaryIndex<0) return [];
  return [...new Set([(primaryIndex-1+total)%total,primaryIndex,(primaryIndex+1)%total])];
}

function calcRaw(names){
  const essences=names.filter(n=>RAW[n]?.kind==='Essence');
  const form=names.find(n=>RAW[n]?.kind==='Form');
  const forces=names.filter(n=>RAW[n]?.kind==='Force');
  const essenceBase=essences.reduce((s,n)=>s+RAW[n].d,0);
  const formBase=form?RAW[form].d:0;
  let base=essenceBase+formBase;
  const flags={essences:[...essences],form};

  if(essences.includes('Fire')&&essences.includes('Air')) base*=1.10;
  if(essences.includes('Lightning')&&essences.includes('Air')){base*=1.10;flags.stun=true;}
  if(essences.includes('Ice')&&essences.includes('Air')) flags.freeze=true;
  if(essences.includes('Acid')&&essences.includes('Water')) flags.corrode=true;
  if(form==='Blade') { flags.blade=true; flags.bladeRatio=(essenceBase+formBase)?formBase/(essenceBase+formBase):0; }
  if(form==='Wave') flags.wave=true;
  if(form==='Burst') flags.burst=true;
  if(form==='Bind') flags.bind=true;
  if(form==='Coat') flags.coat=true;

  for(const f of forces) base*=RAW[f].mult;
  return {base,oc:names.reduce((s,n)=>s+(RAW[n]?.oc||0),0),flags,label:names.join(' + ')};
}

function calcRawBarrier(names){
  const essences=names.filter(n=>RAW[n]?.kind==='Essence');
  let hp=80+essences.reduce((s,n)=>s+RAW[n].d,0);
  if(essences.includes('Fire')&&essences.includes('Air')) hp*=1.10;
  if(essences.includes('Lightning')&&essences.includes('Air')) hp*=1.10;
  if(essences.includes('Earth')) hp*=1.20;
  return {
    base:hp,
    oc:1+essences.reduce((s,n)=>s+RAW[n].oc,0),
    flags:{rawBarrier:true,essences:[...essences]},
    label:`${essences.join(' + ')} + Barrier Form`,
    barrierName:`${essences.join('/')} Raw Barrier`
  };
}

function calcConfigured(name){
  const m=CONFIGURED[name];
  const flags={...m,essences:[...(m.essences||[])],form:m.form||null};
  if(m.blade) flags.bladeRatio=(m.bladeBase||15)/(m.totalBase||m.d||1);
  return {base:m.d||0,oc:m.oc,flags,label:name};
}

function isArea(result){
  const f=result.flags||{};
  return !!(f.wave || (f.burst&&result.roll===4) || f.ricochet);
}

function sideDamage(result){
  if(result.flags?.ricochet){
    if(result.roll===1) return 0;
    if(result.roll===2) return 15;
    if(result.roll===4) return 30;
    return 25;
  }
  return result.damage;
}

function clashElementalAdjusted(attackResult,counterResult){
  let a=attackResult.damage,c=counterResult?counterResult.damage:0;
  if(counterResult){
    const ae=attackResult.flags?.essences||[];
    const ce=counterResult.flags?.essences||[];
    if(ae.includes('Water')&&ce.includes('Fire')) a=round5(a*1.20);
    if(ce.includes('Water')&&ae.includes('Fire')) c=round5(c*1.20);
  }
  return {attack:a,counter:c};
}

module.exports={clamp,round5,hpForPlayers,decksForPlayers,areaSeatIndices,calcRaw,calcRawBarrier,calcConfigured,isArea,sideDamage,clashElementalAdjusted};
