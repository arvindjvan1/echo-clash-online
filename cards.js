'use strict';

const RAW = {
  Fire:{kind:'Essence',d:25,oc:1,rules:['Fire + Air: +10% damage.']},
  Water:{kind:'Essence',d:15,oc:1,rules:['+20% in a Clash against a Fire configuration.']},
  Earth:{kind:'Essence',d:20,oc:1,rules:['+20% effectiveness with / against Barriers.']},
  Air:{kind:'Essence',d:15,oc:1,rules:['Fire + Air: +10%. Lightning + Air: +10% + Stun.']},
  Ice:{kind:'Essence',d:20,oc:2,rules:['Ice + Air: Freeze the target if the configuration reaches them.']},
  Lightning:{kind:'Essence',d:25,oc:2,rules:['Lightning + Air: +10% + Stun.']},
  Acid:{kind:'Essence',d:15,oc:2,rules:['+20% effectiveness against Monsters.','Acid + Water: Corrosion D10 for the next 2 turns.']},

  Projectile:{kind:'Form',d:10,oc:1,rules:['Single-target form.']},
  Wave:{kind:'Form',d:15,oc:2,rules:['Area form: primary target plus adjacent seats.','Only the primary target may Counter.','After Barrier, Wave affects the target Player and active Monster simultaneously.']},
  Blade:{kind:'Form',d:15,oc:2,rules:['Blade component hits the Barrier; Essence component penetrates the Barrier.','Monster can still Guard penetrating damage.']},
  Burst:{kind:'Form',d:20,oc:2,rules:['If an Unstable/Rupture d4 is 4, the attack becomes an area hit.']},
  Bind:{kind:'Form',d:5,oc:2,rules:['If it reaches the target before their scheduled Action, they skip that Action.','Spike Bind: D5 at the start of their next 2 turns.']},
  Coat:{kind:'Form',d:5,oc:1,rules:['Fire Coat: Burn D10 for 2 turns.','Acid Coat: Corrosion D10 for 2 turns.']},
  'Barrier Form':{kind:'BarrierForm',hp:80,oc:1,rules:['Exclusive Raw Barrier form. Combine with Essence cards only.','Cannot combine with another Form or Force.','Earth increases the resulting Barrier HP by 20%.']},

  Compression:{kind:'Force',mult:2,oc:2,rules:['Multiply configuration damage ×2.','Forces stack multiplicatively.']},
  Acceleration:{kind:'Force',mult:2,oc:2,rules:['Multiply configuration damage ×2.','Forces stack multiplicatively.']},
  Amplifier:{kind:'Force',mult:3,oc:3,rules:['Multiply configuration damage ×3.','Forces stack multiplicatively.']},
  Explosion:{kind:'Force',mult:4,oc:4,rules:['Multiply configuration damage ×4.','Forces stack multiplicatively.']},
};

const CONFIGURED = {
  Fireball:{kind:'Configured',d:70,oc:4,essences:['Fire'],form:'Projectile',rules:['Fire + Projectile + Acceleration.','Single target.']},
  'Lightning Arc':{kind:'Configured',d:60,oc:5,essences:['Lightning','Air'],form:'Wave',wave:true,stun:true,rules:['Area attack.','Stuns Players reached by the configuration.']},
  'Frost Lance':{kind:'Configured',d:35,oc:4,essences:['Ice'],form:'Blade',blade:true,bladeBase:15,totalBase:35,rules:['Blade penetration.','D15 Blade component faces Barrier; Ice component penetrates.']},
  'Corrosive Surge':{kind:'Configured',d:45,oc:5,essences:['Acid','Water'],form:'Wave',wave:true,corrode:true,rules:['Area attack.','Corrosion D10 for 2 turns.','Acid gets +20% effectiveness against Monsters.']},
  'Flame Mantle':{kind:'Configured',d:30,oc:2,essences:['Fire'],form:'Coat',burn:true,rules:['Applies Burn D10 for 2 turns if it reaches a Player.']},
  'Stone Spikes':{kind:'Configured',d:25,oc:3,essences:['Earth'],form:'Bind',bind:true,rules:['Stops the target’s next scheduled Action if it reaches them.','Spike Bind D5 for 2 turns.']},
  'Thunder Burst':{kind:'Configured',d:45,oc:4,essences:['Lightning'],form:'Burst',burst:true,rules:['On d4 = 4, becomes an area hit at the rolled damage.']},
  'Gale Shot':{kind:'Configured',d:50,oc:4,essences:['Air'],form:'Projectile',rules:['Air + Projectile + Acceleration.']},
  'Phase Strike':{kind:'Configured',d:40,oc:4,phase:true,rules:['Bypasses Barrier and Monster.','Echo Shell still protects the Player.']},
  'Echo Shell':{kind:'Configured',d:0,oc:3,shell:true,rules:['Self-only utility configuration.','Create D60 temporary Shell HP.','Shell lasts until destroyed or the start of your next scheduled Action.','Not a Barrier.']},
  'Ricochet Arrow':{kind:'Configured',d:45,oc:4,form:'Projectile',ricochet:true,rules:['Primary target takes normal damage.','Adjacent side Players take secondary damage: 15 on d4=2, 25 stable/d4=3, 30 on d4=4.','Side Players cannot Counter.']},
  'Echo Collapse':{kind:'Configured',d:20,oc:4,collapse:true,rules:['After reaching a Player, immediately trigger all remaining lingering ticks on that Player and remove those lingering effects.','If the configuration fails to reach the Player, lingering remains.']},
};

const MONSTERS = {
  Ashfang:{kind:'Monster',hp:140,guard:.40,atk:30,rules:['If attacking a Burning Player, +D10.']},
  Stoneback:{kind:'Monster',hp:160,guard:.60,atk:20,mitigation:10,rules:['When Guarding, reduce intercepted damage by D10 before HP loss.','Overkill passes to the Player.']},
  Stormclaw:{kind:'Monster',hp:130,guard:.45,atk:25,rules:['When hit and survives, gain 1 Charge.','Next autoattack gets +D10, then Charge is removed.']},
  Rotcrawler:{kind:'Monster',hp:120,guard:.35,atk:20,rules:['If it damages a Player who already has lingering damage, add one extra D10 lingering tick, max 2 Rotcrawler ticks.']},
  Emberhide:{kind:'Monster',hp:150,guard:.50,atk:20,rules:['If damaged by an opposing configuration and survives, deal D10 immediately to that configuration’s caster.']},
  Shardling:{kind:'Monster',hp:100,guard:.30,atk:15,stabilityBonus:1,rules:['Owner gets +1 Stability while Shardling is active.']},
};

const BARRIERS = {
  'Earth Barrier':{kind:'Barrier',hp:120,oc:2,rules:['Stable at Stability 3.']},
  'Flame Barrier':{kind:'Barrier',hp:105,oc:2,retaliate:5,rules:['Any attacker that damages it takes D5.']},
  'Water Barrier':{kind:'Barrier',hp:95,oc:2,reduce:10,rules:['Flow: reduce incoming damage by D10 once per configuration/attack.']},
  'Wind Barrier':{kind:'Barrier',hp:95,oc:2,projectileReduce:15,rules:['Projectile attacks are reduced by D15 before Barrier damage.']},
  'Ice Barrier':{kind:'Barrier',hp:100,oc:3,onBreak:'freeze',rules:['When destroyed, the attacker loses their next scheduled Action.']},
  'Lightning Barrier':{kind:'Barrier',hp:105,oc:3,retaliate:5,breakRetaliate:10,rules:['Damaging it deals D5 to the attacker.','If destroyed by that hit, retaliation is D10 instead.']},
  'Acid Barrier':{kind:'Barrier',hp:95,oc:3,corrodeAttacker:true,rules:['Damaging it gives the attacker Corrosion D10 for 2 turns.']},
  'Storm Barrier':{kind:'Barrier',hp:120,oc:4,onBreak:'storm',rules:['When destroyed, attacker takes D20 and loses their next scheduled Action.']},
  'Magma Barrier':{kind:'Barrier',hp:150,oc:3,retaliate:5,breakRetaliate:10,rules:['Damaging it deals D5 to attacker.','If destroyed by that hit, retaliation is D10 instead.']},
  'Glacial Barrier':{kind:'Barrier',hp:115,oc:4,reduce:10,onBreak:'freeze',rules:['Flow: reduce incoming D10.','When destroyed, attacker loses their next scheduled Action.']},
  'Inferno Barrier':{kind:'Barrier',hp:130,oc:3,inferno:true,rules:['Attacker takes D10 immediately and Burn D10 at the start of their next scheduled turn.']},
  'Permafrost Barrier':{kind:'Barrier',hp:145,oc:4,onBreak:'stabilityDown',rules:['When destroyed, attacker gets −2 Stability for one full round.']},
};

const SUPPORT = {
  Heal:{kind:'Support',rules:['Restore 50 current HP to yourself.','Cannot heal a Barrier or restore sacrificed max HP.']},
  'Stability Boost':{kind:'Support',rules:['+2 Stability through the end of your next scheduled Action.']},
  'Output Boost':{kind:'Support',rules:['+2 Output through the end of your next scheduled Action.']},
  Cleanse:{kind:'Support',rules:['Remove Burn, Corrosion, Spike Bind, temporary Stability reduction, Stun or Freeze.','Cannot remove Rupture Strain.']},
  'Monster Heal':{kind:'Support',rules:['Restore 80 HP to your active Monster, up to its printed max HP.']},
  Stabilize:{kind:'Support',rules:['Your next Unstable configuration at or below Output resolves at 100% without a d4.','Does not prevent Rupture and never bypasses a mandatory Rupture d4.']},
};

const ALL = {...RAW,...CONFIGURED,...MONSTERS,...BARRIERS,...SUPPORT};
const CARD_NAMES = Object.keys(ALL);

function publicCatalog(){
  const out={};
  for(const [name,m] of Object.entries(ALL)){
    let type=m.kind;
    if(type==='BarrierForm') type='Form';
    out[name]={
      name,type,
      damage:m.d??null,
      hp:m.hp??null,
      attack:m.atk??null,
      guard:m.guard??null,
      oc:m.oc??null,
      multiplier:m.mult??null,
      rules:m.rules||[],
      essences:m.essences||[],
      form:m.form||null,
    };
  }
  return out;
}

module.exports={RAW,CONFIGURED,MONSTERS,BARRIERS,SUPPORT,ALL,CARD_NAMES,publicCatalog};
