// AETHERFALL client — English catalog (source of truth).
//
// This module is the single source of truth for every translatable string:
//   * `catalog` — client-owned UI copy (HUD, settings, a11y panel, overlays).
//   * `SERVER_TEXT_INDEX` — English server/authored prose -> catalog key, so a
//     raw string coming off the wire (Elder Maren dialogue, chat system lines,
//     item/boss/mob names) can be translated client-side by exact match.
//
// Type discipline: `MessageKey = keyof typeof catalog` lives in ../i18n.ts, and
// every sibling locale is typed `Catalog`, so TypeScript itself rejects a locale
// that is missing a key. See i18n.test.ts for the runtime + placeholder parity
// checks that back this up.

export const catalog = {
  // ---------------------------------------------------------------- HUD ---
  'hud.label': 'Heads-up display',
  'hud.hp': 'HP',
  'hud.xp': 'XP',
  'hud.level': 'Lv',
  'hud.slots': '{used}/20 slots',
  'hud.inventory': 'Inventory',
  'hud.slot.empty': 'empty slot',
  'hud.slot.item': 'Item: {name}',
  'hud.quests': 'QUESTS',
  'hud.quest.active': 'active',
  'hud.quest.done': 'done',
  'hud.killFeed': 'Combat log',
  'hud.chat': 'Chat',
  'hud.chatPlaceholder': 'chat + Enter...',
  'hud.channel': 'Channel',
  'hud.channel.global': 'global',
  'hud.channel.say': 'say',
  'hud.channel.guild': 'guild',
  'hud.minimap': 'Minimap',
  'hud.leaderboard': 'SOULS',
  'hud.noSouls': 'no souls yet',
  'hud.bossBar': 'Boss health',
  'hud.bossHp': '{hp} of {max} health',
  'hud.lbRow': '{name}, level {level}, {hp} of {max} health',
  'hud.lbDead': 'dead',
  'hud.status': 'Status',
  'hud.statusLine': '{renderer} · ping {ping}ms · {fps}fps · position {x}, {y} · entities {ents}',

  // ------------------------------------------------------- top bar / chrome ---
  'topbar.title': 'AETHERFALL',
  'topbar.connecting': 'connecting...',
  'topbar.leaderboard': 'Leaderboard (L)',
  'topbar.mute': 'Mute or unmute (M)',
  'topbar.settings': 'Settings',
  'topbar.accessibility': 'Accessibility options',
  'settings.title': 'SETTINGS',
  'settings.renderer': 'Renderer',
  'settings.renderer.auto': 'Auto',
  'settings.renderer.three': 'Three',
  'settings.renderer.canvas': 'Canvas',
  'settings.quality': 'Quality',
  'settings.quality.low': 'Low',
  'settings.quality.med': 'Med',
  'settings.quality.high': 'High',
  'settings.distance': 'Render distance',
  'settings.showFps': 'Show FPS meter',
  'settings.mute': 'Mute sounds',
  'settings.done': 'Done',

  // ------------------------------------------------------------- overlays ---
  'death.title': 'YOU FELL',
  'death.sub': 'The ether claims another soul. You wake at the shrine…',
  'death.respawn': 'Respawn',
  'death.dialog': 'You died. Activate Respawn to return to the shrine.',
  'loading.connecting': 'Connecting…',
  'loading.world': 'Loading world…',
  'loading.failed': 'Connection failed — is the server up?',
  'loading.slow': 'Still connecting… is ws://localhost:8081 up?',
  'join.title': 'ENTER THE FALL',
  'join.name': 'SOUL NAME',
  'join.server': 'SERVER',
  'join.button': 'Join',

  // ------------------------------------------------------- accessibility UI ---
  'a11y.title': 'ACCESSIBILITY',
  'a11y.language': 'Language',
  'a11y.language.en': 'English',
  'a11y.language.tr': 'Türkçe',
  'a11y.language.de': 'Deutsch',
  'a11y.language.es': 'Español',
  'a11y.contrast': 'High contrast theme',
  'a11y.contrast.hint': 'Pure black panels, white text, stronger borders.',
  'a11y.palette': 'Colour palette',
  'a11y.palette.hint': 'Palette picked for red/green colour blindness.',
  'a11y.palette.default': 'Default',
  'a11y.palette.deuteranopia': 'Deuteranopia-safe',
  'a11y.palette.protanopia': 'Protanopia-safe',
  'a11y.palette.tritanopia': 'Tritanopia-safe',
  'a11y.motion': 'Reduced motion',
  'a11y.motion.hint': 'No screen shake, particles or transitions.',
  'a11y.textScale': 'Text size',
  'a11y.textScale.hint': 'Scales HUD and menu text from 90% to 150%.',
  'a11y.announce': 'Screen reader announcements',
  'a11y.announce.hint': 'Joins, deaths, quests, boss telegraphs and low health.',
  'a11y.moveScheme': 'Movement keys',
  'a11y.moveScheme.wasd': 'W A S D',
  'a11y.moveScheme.arrows': 'Arrow keys',
  'a11y.moveScheme.ijkl': 'I J K L',
  'a11y.moveScheme.numpad': 'Numpad 8 4 5 6',
  'a11y.attackKey': 'Attack key',
  'a11y.attackKey.hint': 'Press a key to rebind the attack action.',
  'a11y.clickToAttack': 'Click to attack',
  'a11y.holdToAttack': 'Hold to attack',
  'a11y.liveRegion': 'Announcements',
  'a11y.liveRegion.off': 'Announcements are off.',
  'a11y.skip': 'Skip to game',
  'a11y.skipGame': 'Skip to game view',
  'a11y.help': 'Keyboard help',
  'a11y.help.keys': 'Press Enter to chat, Tab to move between HUD widgets, and Escape to close panels.',
  'a11y.reset': 'Reset to defaults',
  'a11y.capturing': 'Press a key for {action}… (Escape cancels)',
  'a11y.saved': 'Accessibility settings saved.',

  // ------------------------------------------- screen reader announcements ---
  'ann.join': '{name} joined the world',
  'ann.leave': '{name} left the world',
  'ann.death': '{name} was slain',
  'ann.deathSelf': 'You died',
  'ann.respawnSelf': 'You respawned at the shrine',
  'ann.questProgress': 'Quest updated: {title}. {obj}',
  'ann.questComplete': 'Quest complete: {title}',
  'ann.telegraph': 'Boss attack incoming: {label}',
  'ann.lowHp': 'Low health: {hp} of {max}',
  'ann.item': 'Received {item}',
  'ann.inventoryFull': 'Inventory full',
  'ann.levelUp': 'Level {level}',
  'ann.bossAppeared': 'Boss appeared: {name}',
  'ann.chat': '{from} says: {text}',
  'ann.panelOpen': '{panel} opened',
  'ann.panelClose': '{panel} closed',

  // ------------------------------------------ server prose: chat system ---
  'srv.chat.joined': '{name} joined',
  'srv.chat.disconnected': 'disconnected — reload to rejoin',
  'srv.chat.rateLimited': 'chat throttled — slow down',
  'srv.chat.badProto': 'server rejected protocol version',
  'srv.chat.kicked': 'Kicked: {reason}',
  'srv.chat.kickedDefault': 'policy violation',
  'srv.chat.redirect': 'Redirecting to shard {url}',
  'srv.chat.redirectAny': 'Redirecting to another shard…',
  'srv.chat.queue': 'Queued — position {pos} of {max}',
  'srv.chat.queueAny': 'Queued for a shard…',

  // ------------------------------------------ server prose: combat feed ---
  'srv.kill.slain': '{name} slain',
  'srv.kill.fallen': '{name} has fallen',
  'srv.kill.rose': '{name} rose again at the shrine',
  'srv.kill.boss': '{name} felled',
  'srv.kill.quest': 'Quest complete: {name}',
  'srv.kill.invFull': 'inventory full!',
  'srv.kill.looted': 'looted {item}',
  'srv.kill.chainDone': "Elder Maren's chain complete — the Ward Blade is yours",

  // ---------------------------------------------- server prose: quest chain ---
  'srv.quest.ward-spark.name': 'Ward-Spark',
  'srv.quest.ward-spark.brief': 'Rekindle the road: drive off 3 meadow gloomfangs for Elder Maren.',
  'srv.quest.ember-road.name': 'Ember Road',
  'srv.quest.ember-road.brief': 'Gather 5 ember-shards along the old road.',
  'srv.quest.deep-delvers.name': 'Deep Delvers',
  'srv.quest.deep-delvers.brief': 'Cull 6 Hollow Deep delvers: ashcrawlers, thornbacks, hollow-knights.',
  'srv.quest.chart-the-fall.name': 'Chart the Fall',
  'srv.quest.chart-the-fall.brief': 'Chart 4 new chunks beyond the highlands.',
  'srv.quest.heart-of-fall.name': 'Heart of the Fall',
  'srv.quest.heart-of-fall.brief': 'Face the Ashfall Caldera: fell 8 volcano horrors. Maren promises the Ward Blade.',
  'srv.quest.progress': '{title} ({count}/{goal})',

  // ------------------------------------------ server prose: Elder Maren ---
  'srv.speaker.elderMaren': 'Elder Maren',
  'srv.dialogue.greeting.text':
    'Traveler. The ward-stones south of the gate have gone dark, and gloomfangs nest in the brush. Will you help Emberfall?',
  'srv.dialogue.quest_offer.text':
    'Three ward-stones line the old road. Touch each one to rekindle it, and drive off the gloomfangs that gather near. Return to me when the road burns blue again.',
  'srv.dialogue.where.text':
    'Follow the old road south past the gate — you will see their cold sockets glowing faintly. Stay on the path; the brush beyond the second stone is thick with fangs.',
  'srv.dialogue.reward.text':
    'A ward-forged blade from the armory, and Emberfall remembers its friends. The merchants will trade fair with one who carries my token.',
  'srv.dialogue.accepted.text':
    'Good. The stones wait south of the gate. Come back when all three burn blue — say "done" and I will know you by the light you carry.',
  'srv.dialogue.done_check.text':
    'The road burns blue! You have done what three patrols could not. Take the ward-blade — and my thanks.',
  'srv.dialogue.not_done.text':
    'Not yet — the stones still sleep. South of the gate, traveler. Touch each ward-stone and drive back the gloomfangs.',
  'srv.dialogue.bye.text': 'Walk in the light, traveler.',
  'srv.dialogue.ember_road.text':
    'The ward-stones woke, but their light is hungry. Bring me 5 ember-shards from the road — the merchants will pay, and so will I.',
  'srv.dialogue.where_shards.text':
    'Warm glass, glowing faintly blue at the edges. Gloomfangs hoard them in the brush — check the meadow south of the gate.',
  'srv.dialogue.accepted_ember.text':
    'Five shards, traveler. Say "done" when your pack glows with them.',
  'srv.dialogue.deep_delvers.text':
    'The light reached the Hollow Deep — and woke what nests there. Cull 6 delvers: ashcrawlers, thornbacks, hollow-knights. Steel yourself first.',
  'srv.dialogue.where_deep.text':
    'North-east past the meadow, where grass gives way to moss and cracked stone. Their chitin turns blades — bring the ember-axe if you have it.',
  'srv.dialogue.accepted_deep.text': 'Six delvers. Come back breathing and I will know the Deep fears you.',
  'srv.dialogue.chart_fall.text':
    'Our maps end at the highlands. Chart 4 new tracts beyond them — walk far, walk wary, and the Fall will be yours on parchment.',
  'srv.dialogue.where_chart.text':
    'Just walk. Every new tract you set foot in sings back to my map-table. Four beyond the highlands — the ash on the wind means you are close.',
  'srv.dialogue.accepted_chart.text': 'Four new tracts. Say "done" when the map-table glows.',
  'srv.dialogue.heart_fall.text':
    'Last, traveler, and hardest: the Ashfall Caldera. Fell 8 of its horrors and I will lay the Ward Blade itself in your hands.',
  'srv.dialogue.where_heart.text':
    "Cinder-imps, wyrms, magma-golems — the mountain's fever dreams. Obsidian chips mark their nests. Take a greatsword's courage with you.",
  'srv.dialogue.accepted_heart.text': 'Eight horrors. When the caldera quiets, say "done" — and claim the Ward Blade.',
  'srv.dialogue.option': '{n}. {label}',

  // dialogue option labels (server appends them as "1. label 2. label")
  'srv.opt.tellStones': 'Tell me about the ward-stones. (quest)',
  'srv.opt.reward': 'What do I get for helping? (reward)',
  'srv.opt.bye': 'Farewell. (bye)',
  'srv.opt.yes': 'I accept. (yes)',
  'srv.opt.no': 'Not right now. (no)',
  'srv.opt.where': 'Where exactly? (where)',
  'srv.opt.back': 'Back. (bye)',
  'srv.opt.thanks': 'Thank you. (bye)',
  'srv.opt.helloAgain': 'Greetings again. (hello)',
  'srv.opt.gather': 'I will gather them. (yes)',
  'srv.opt.shardLook': 'What do the shards look like? (where)',
  'srv.opt.whereAgain': 'Where again? (where)',
  'srv.opt.deepWhere': 'Where is the Deep? (where)',
  'srv.opt.chartHow': 'How do I chart? (where)',
  'srv.opt.howAgain': 'How again? (where)',
  'srv.opt.waits': 'What waits there? (where)',

  // ------------------------------------------- server prose: world entities ---
  'srv.item.ember-shard': 'Ember Shard',
  'srv.item.gloom-fang': 'Gloom Fang',
  'srv.item.moss-cap': 'Moss Cap',
  'srv.item.healing-herb': 'Healing Herb',
  'srv.item.minor-potion': 'Minor Potion',
  'srv.item.mana-mote': 'Mana Mote',
  'srv.item.iron-ore': 'Iron Ore',
  'srv.item.ash-coal': 'Ash Coal',
  'srv.item.obsidian-chip': 'Obsidian Chip',
  'srv.item.ward-token': 'Ward Token',
  'srv.item.wisp-touched-dagger': 'Wisp-Touched Dagger',
  'srv.item.ward-blade': 'Ward Blade',
  'srv.item.ember-axe': 'Ember Axe',
  'srv.item.deep-halberd': 'Deep Halberd',
  'srv.item.caldera-greatsword': 'Caldera Greatsword',

  'srv.mob.gloomfang': 'gloomfang',
  'srv.mob.mistwisp': 'mistwisp',
  'srv.mob.thornback': 'thornback',
  'srv.mob.meadow-sprite': 'meadow-sprite',
  'srv.mob.ashcrawler': 'ashcrawler',
  'srv.mob.hollow-knight': 'hollow-knight',
  'srv.mob.cinder-imp': 'cinder-imp',
  'srv.mob.caldera-wyrm': 'caldera-wyrm',
  'srv.mob.void-wisp': 'void-wisp',
  'srv.mob.magma-golem': 'magma-golem',

  'srv.boss.stone-golem': 'Stone Golem',
  'srv.boss.ember-wyrm': 'Ember Wyrm',
  'srv.boss.void-wisp': 'Void Wisp',
  'srv.boss.crypt-warden': 'Crypt Warden',

  'srv.zone.meadow': 'Meadow',
  'srv.zone.dungeon': 'Hollow Deep',
  'srv.zone.volcano': 'Ashfall Caldera',

  'srv.telegraph.golem-slam': 'Golem slam',
  'srv.telegraph.wisp-blink': 'Wisp blink',
  'srv.telegraph.wisp-burst': 'Wisp burst',
  'srv.telegraph.wyrm-charge': 'Wyrm charge',
  'srv.telegraph.wyrm-fire': 'Wyrm fire',
  'srv.telegraph.warden-slam': 'Warden slam',
  'srv.telegraph.warden-husk': 'Warden husk',
  'srv.telegraph.warden-shield': 'Warden shield',
  'srv.telegraph.unknown': 'Attack',

  // ------------------------------------------ client prose: toasts/tutorial ---
  'toast.levelUp': '⬆ Level {level}!',
  'toast.questComplete': 'Quest complete — {name}',
  'toast.chainDone': "🏆 Elder Maren's chain complete — the Ward Blade is yours",
  'toast.bossFelled': '{name} felled!',
  'toast.threeOn': 'Switched to Three.js isometric renderer',
  'toast.canvasOn': 'Switched to Canvas2D renderer',
  'toast.noWebgl': 'WebGL unavailable — Canvas2D fallback active',
  'toast.noWebglStay': 'WebGL unavailable — staying on Canvas2D',
  'toast.autoThree': 'Auto renderer: Three.js active',
  'toast.lowFps': 'Perf: fps < 30 for 5s — auto-fallback to Canvas2D',
  'tut.move.touch': 'Left stick to move · ATTACK to swing',
  'tut.maren.touch': 'Elder Maren waits at the shrine (50, 50)',
  'tut.rings.touch': 'Red rings = boss attacks — step out!',
  'tut.move': 'WASD / arrows to move · Space or click to attack',
  'tut.chat': 'Enter opens chat · L leaderboard · M mute · ⚙ settings',
  'tut.maren': 'Talk to Elder Maren at the shrine (50, 50)',
  'tut.rings': 'Red rings telegraph boss attacks — step out!',
} as const;

/**
 * Exact English prose -> catalog key. Lets the client translate authored
 * content that arrives over the wire as raw English (see i18n.ts
 * `translateServerText`). Keys are added when a new string lands in
 * server/src/ai/dialogue.ts, server/src/game/content.ts, or a chat system line.
 */
export const SERVER_TEXT_INDEX: Readonly<Record<string, string>> = {
  // chat system lines (server/src/index.ts broadcastGlobal)
  '{name} joined': 'srv.chat.joined',
  'disconnected — reload to rejoin': 'srv.chat.disconnected',
  'chat throttled — slow down': 'srv.chat.rateLimited',
  'server rejected protocol version': 'srv.chat.badProto',

  // Elder Maren speakers
  'Elder Maren': 'srv.speaker.elderMaren',

  // Elder Maren dialogue nodes (server/src/ai/dialogue.ts ELDER_MAREN_NODES)
  'Traveler. The ward-stones south of the gate have gone dark, and gloomfangs nest in the brush. Will you help Emberfall?':
    'srv.dialogue.greeting.text',
  'Three ward-stones line the old road. Touch each one to rekindle it, and drive off the gloomfangs that gather near. Return to me when the road burns blue again.':
    'srv.dialogue.quest_offer.text',
  'Follow the old road south past the gate — you will see their cold sockets glowing faintly. Stay on the path; the brush beyond the second stone is thick with fangs.':
    'srv.dialogue.where.text',
  'A ward-forged blade from the armory, and Emberfall remembers its friends. The merchants will trade fair with one who carries my token.':
    'srv.dialogue.reward.text',
  'Good. The stones wait south of the gate. Come back when all three burn blue — say "done" and I will know you by the light you carry.':
    'srv.dialogue.accepted.text',
  'The road burns blue! You have done what three patrols could not. Take the ward-blade — and my thanks.':
    'srv.dialogue.done_check.text',
  'Not yet — the stones still sleep. South of the gate, traveler. Touch each ward-stone and drive back the gloomfangs.':
    'srv.dialogue.not_done.text',
  'Walk in the light, traveler.': 'srv.dialogue.bye.text',
  'The ward-stones woke, but their light is hungry. Bring me 5 ember-shards from the road — the merchants will pay, and so will I.':
    'srv.dialogue.ember_road.text',
  'Warm glass, glowing faintly blue at the edges. Gloomfangs hoard them in the brush — check the meadow south of the gate.':
    'srv.dialogue.where_shards.text',
  'Five shards, traveler. Say "done" when your pack glows with them.': 'srv.dialogue.accepted_ember.text',
  'The light reached the Hollow Deep — and woke what nests there. Cull 6 delvers: ashcrawlers, thornbacks, hollow-knights. Steel yourself first.':
    'srv.dialogue.deep_delvers.text',
  'North-east past the meadow, where grass gives way to moss and cracked stone. Their chitin turns blades — bring the ember-axe if you have it.':
    'srv.dialogue.where_deep.text',
  'Six delvers. Come back breathing and I will know the Deep fears you.': 'srv.dialogue.accepted_deep.text',
  'Our maps end at the highlands. Chart 4 new tracts beyond them — walk far, walk wary, and the Fall will be yours on parchment.':
    'srv.dialogue.chart_fall.text',
  'Just walk. Every new tract you set foot in sings back to my map-table. Four beyond the highlands — the ash on the wind means you are close.':
    'srv.dialogue.where_chart.text',
  'Four new tracts. Say "done" when the map-table glows.': 'srv.dialogue.accepted_chart.text',
  'Last, traveler, and hardest: the Ashfall Caldera. Fell 8 of its horrors and I will lay the Ward Blade itself in your hands.':
    'srv.dialogue.heart_fall.text',
  "Cinder-imps, wyrms, magma-golems — the mountain's fever dreams. Obsidian chips mark their nests. Take a greatsword's courage with you.":
    'srv.dialogue.where_heart.text',
  'Eight horrors. When the caldera quiets, say "done" — and claim the Ward Blade.': 'srv.dialogue.accepted_heart.text',

  // dialogue option labels
  'Tell me about the ward-stones. (quest)': 'srv.opt.tellStones',
  'What do I get for helping? (reward)': 'srv.opt.reward',
  'Farewell. (bye)': 'srv.opt.bye',
  'I accept. (yes)': 'srv.opt.yes',
  'Not right now. (no)': 'srv.opt.no',
  'Where exactly? (where)': 'srv.opt.where',
  'Back. (bye)': 'srv.opt.back',
  'Thank you. (bye)': 'srv.opt.thanks',
  'Greetings again. (hello)': 'srv.opt.helloAgain',
  'I will gather them. (yes)': 'srv.opt.gather',
  'What do the shards look like? (where)': 'srv.opt.shardLook',
  'Where again? (where)': 'srv.opt.whereAgain',
  'Where is the Deep? (where)': 'srv.opt.deepWhere',
  'How do I chart? (where)': 'srv.opt.chartHow',
  'How again? (where)': 'srv.opt.howAgain',
  'What waits there? (where)': 'srv.opt.waits',

  // quest names + briefings (server/src/game/content.ts QUEST_CHAIN)
  'Ward-Spark': 'srv.quest.ward-spark.name',
  'Rekindle the road: drive off 3 meadow gloomfangs for Elder Maren.': 'srv.quest.ward-spark.brief',
  'Ember Road': 'srv.quest.ember-road.name',
  'Gather 5 ember-shards along the old road.': 'srv.quest.ember-road.brief',
  'Deep Delvers': 'srv.quest.deep-delvers.name',
  'Cull 6 Hollow Deep delvers: ashcrawlers, thornbacks, hollow-knights.': 'srv.quest.deep-delvers.brief',
  'Chart the Fall': 'srv.quest.chart-the-fall.name',
  'Chart 4 new chunks beyond the highlands.': 'srv.quest.chart-the-fall.brief',
  'Heart of the Fall': 'srv.quest.heart-of-fall.name',
  'Face the Ashfall Caldera: fell 8 volcano horrors. Maren promises the Ward Blade.':
    'srv.quest.heart-of-fall.brief',

  // items (server/src/game/content.ts ITEMS + WEAPONS)
  'Ember Shard': 'srv.item.ember-shard',
  'Gloom Fang': 'srv.item.gloom-fang',
  'Moss Cap': 'srv.item.moss-cap',
  'Healing Herb': 'srv.item.healing-herb',
  'Minor Potion': 'srv.item.minor-potion',
  'Mana Mote': 'srv.item.mana-mote',
  'Iron Ore': 'srv.item.iron-ore',
  'Ash Coal': 'srv.item.ash-coal',
  'Obsidian Chip': 'srv.item.obsidian-chip',
  'Ward Token': 'srv.item.ward-token',
  'Wisp-Touched Dagger': 'srv.item.wisp-touched-dagger',
  'Ward Blade': 'srv.item.ward-blade',
  'Ember Axe': 'srv.item.ember-axe',
  'Deep Halberd': 'srv.item.deep-halberd',
  'Caldera Greatsword': 'srv.item.caldera-greatsword',

  // mobs (server/src/game/content.ts MOB_SPAWN_TABLE) — lowercase wire form
  gloomfang: 'srv.mob.gloomfang',
  mistwisp: 'srv.mob.mistwisp',
  thornback: 'srv.mob.thornback',
  'meadow-sprite': 'srv.mob.meadow-sprite',
  ashcrawler: 'srv.mob.ashcrawler',
  'hollow-knight': 'srv.mob.hollow-knight',
  'cinder-imp': 'srv.mob.cinder-imp',
  'caldera-wyrm': 'srv.mob.caldera-wyrm',
  'void-wisp': 'srv.mob.void-wisp',
  'magma-golem': 'srv.mob.magma-golem',

  // bosses (client/src/bosses.ts BOSS_NAMES)
  'Stone Golem': 'srv.boss.stone-golem',
  'Ember Wyrm': 'srv.boss.ember-wyrm',
  'Void Wisp': 'srv.boss.void-wisp',
  'Crypt Warden': 'srv.boss.crypt-warden',

  // zones (server/src/game/content.ts ZoneId)
  meadow: 'srv.zone.meadow',
  dungeon: 'srv.zone.dungeon',
  volcano: 'srv.zone.volcano',

  // telegraph labels (server/src/ai/bosses.ts)
  'golem-slam': 'srv.telegraph.golem-slam',
  'wisp-blink': 'srv.telegraph.wisp-blink',
  'wisp-burst': 'srv.telegraph.wisp-burst',
  'wyrm-charge': 'srv.telegraph.wyrm-charge',
  'wyrm-fire': 'srv.telegraph.wyrm-fire',
  'warden-slam': 'srv.telegraph.warden-slam',
  'warden-husk': 'srv.telegraph.warden-husk',
  'warden-shield': 'srv.telegraph.warden-shield',
};