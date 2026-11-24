<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { MultiPoseCamera } from '@/games/ultraman-duel/poseCamera'
import { UltramanGameEngine } from '@/games/ultraman/engine'
import { HERO_IDS, type HeroId } from '@/games/ultraman/heroes'
import type { BattleHudState, ControlMode, FloatingDamageEvent } from '@/games/ultraman/types'
import UltraSoundtrack from '@/components/UltraSoundtrack.vue'

const { t } = useI18n()
const msg = (key: string) => t('message.ultramanView.' + key)
const foreground = ref(!document.hidden)
const stage = ref<'setup' | 'loading' | 'battle'>('setup')
const mode = ref<ControlMode>('camera')
const heroes = ref<HeroId[]>(['dyna', 'zeta'])
const slots = [0, 1] as const
const video = ref<HTMLVideoElement>()
const boards: (HTMLElement | null)[] = []
const engines: UltramanGameEngine[] = []
const hud = [shallowRef<BattleHudState>(), shallowRef<BattleHudState>()] as const
const hits = [ref<FloatingDamageEvent[]>([]), ref<FloatingDamageEvent[]>([])] as const
const tracked = ref([false, false])
const muted = ref(false)
const camera = new MultiPoseCamera()
const error = ref('')
let session = 0
const ended = (state?: BattleHudState) => state?.phase === 'victory' || state?.phase === 'defeat'
const bothDone = computed(() => hud.every(h => ended(h.value)))
const pairReady = computed(() => mode.value !== 'camera' || slots.every(i => tracked.value[i] || ended(hud[i].value)))
const running = computed(() => stage.value === 'battle' && foreground.value && pairReady.value && !bothDone.value)
const held = new Set<string>()
function clearControls() {
  held.clear()
  for (const game of engines) {
    game.setManualGuard(false)
    game.setManualLean(0)
  }
}
watch(running, active => {
  clearControls()
  for (const game of engines) {
    game.resetTracking()
    game.setPaused(!active)
  }
}, { flush: 'sync' })
watch(bothDone, done => { if (done) camera.stop(video.value ?? null) })
function stop() {
  session++
  stage.value = 'setup'
  camera.stop(video.value ?? null)
  for (const game of engines.splice(0)) game.dispose()
  for (const h of hud) h.value = undefined
  for (const lane of hits) lane.value = []
  tracked.value = [false, false]
}
function fail(reason: unknown) {
  stop()
  error.value = reason instanceof Error ? reason.message : String(reason)
}
camera.onError = fail
camera.onPoses = (poses, now) => {
  const input = video.value
  if (!input || !foreground.value) return
  // 每人拥有固定站位。另一侧暂时离开镜头时，仍保留在场玩家的编号。
  const lanes = slots.map(i => poses.filter(p => (p.mirroredCenterX < 0.5 ? 0 : 1) === i))
  tracked.value = lanes.map(p => p.length === 1)
  if (!running.value) return
  slots.forEach(i => {
    const pose = lanes[i]?.[0]
    if (!pose || ended(hud[i].value)) return
    // 只按站位换算左右移动。伸过中线的手、脚仍按整幅摄像头图像判定。
    engines[i]?.feedPoseLandmarks(pose.landmarks, pose.worldLandmarks, now,
      input.videoWidth, input.videoHeight, i === 0 ? 0.75 : 0.25)
  })
}
async function start() {
  if (stage.value !== 'setup') return
  const id = ++session
  error.value = ''
  stage.value = 'loading'
  try {
    await nextTick()
    if (session !== id) return
    for (const i of slots) {
      const game = new UltramanGameEngine(boards[i]!, {
        onHudUpdate: state => { if (session === id) hud[i].value = state },
        onFloatingText: evt => { if (session === id) hits[i].value.push(evt) },
      })
      engines.push(game)
      game.setPaused(true)
      game.setMuted(muted.value)
      game.audio.unlock()
      await game.setHero(heroes.value[i]!)
      if (session !== id) return
    }
    await Promise.all([
      ...engines.map(game => game.preloadBaseAssets()),
      mode.value === 'camera' ? camera.start(video.value!) : Promise.resolve(),
    ])
    if (session !== id) return
    await Promise.all(engines.map(game => game.startGame(mode.value)))
    if (session === id) stage.value = 'battle'
  } catch (e) {
    if (session === id) fail(e)
  }
}
function syncVisibility() {
  foreground.value = !document.hidden
  if (!foreground.value) tracked.value = [false, false]
}
function toggleMute() {
  muted.value = !muted.value
  engines.forEach(game => game.setMuted(muted.value))
}
const keys = [
  ['KeyA','KeyD','KeyS','KeyF','KeyG','KeyR','KeyT','KeyV'],
  ['ArrowLeft','ArrowRight','ArrowDown','KeyJ','KeyK','KeyI','KeyU','KeyL'],
] as const
function key(event: KeyboardEvent) {
  if (!running.value || mode.value !== 'keyboard') return
  slots.forEach(i => {
    const binding: readonly string[] = keys[i]
    const action = binding.indexOf(event.code)
    const game = engines[i]
    if (!game || action < 0 || ended(hud[i].value)) return
    event.preventDefault()
    if (event.type === 'keyup') held.delete(event.code)
    else held.add(event.code)
    game.setManualLean(held.has(binding[0]!) === held.has(binding[1]!) ? 0 : held.has(binding[0]!) ? -1 : 1)
    game.setManualGuard(held.has(binding[2]!))
    if (event.type === 'keyup' || event.repeat) return
    if (action === 3 || action === 4) game.triggerManualPunch(action === 3 ? 'left' : 'right')
    if (action === 5) game.triggerManualKick('right')
    if (action === 6) game.triggerManualDisc('right')
    if (action === 7) game.triggerManualBeam()
  })
}
onMounted(() => {
  document.addEventListener('visibilitychange', syncVisibility)
  window.addEventListener('blur', clearControls)
  window.addEventListener('keydown', key)
  window.addEventListener('keyup', key)
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', syncVisibility)
  window.removeEventListener('blur', clearControls)
  window.removeEventListener('keydown', key)
  window.removeEventListener('keyup', key)
  stop()
})
</script>

<template>
  <main class="split">
    <header>
      <RouterLink to="/ultraman">‹ {{ msg('back') }}</RouterLink>
      <strong>{{ msg('split') }}</strong>
      <button v-if="stage !== 'setup'" @click="stop">{{ msg(bothDone ? 'result.playAgain' : 'stop') }}</button>
    </header>
    <div v-if="stage !== 'setup'" class="boards">
      <section v-for="i in slots" :key="i" class="board">
        <div :ref="el => { boards[i] = el as HTMLElement | null }" class="renderer" />
        <span v-for="hit in hits[i].value" :key="hit.id" class="hit"
          :style="{ left: hit.x + '%', top: hit.y + '%', color: hit.color }"
          @animationend="hits[i].value = hits[i].value.filter(item => item.id !== hit.id)">{{ hit.text }}</span>
        <template v-if="hud[i].value">
          <div class="meter">
            <b>P{{ i + 1 }} · {{ msg('heroNames.' + heroes[i]) }}</b><span>{{ msg('score') }} {{ hud[i].value!.score }}</span>
            <progress :value="hud[i].value!.heroHp" :max="hud[i].value!.heroMaxHp" />
            <small>{{ msg('monsters.' + hud[i].value!.monsterId) }} · {{ hud[i].value!.monsterHp }} HP</small>
            <small>{{ msg('energy') }} {{ hud[i].value!.energy }}</small>
          </div>
          <div v-if="ended(hud[i].value)" class="outcome">
            {{ msg(hud[i].value!.phase === 'victory' ? 'result.victoryTitle' : 'result.defeatTitle') }}
            <b>{{ msg('score') }} {{ hud[i].value!.score }}</b>
          </div>
          <p v-else-if="hud[i].value!.warningTextKey" class="cue danger">{{ msg('warnings.' + hud[i].value!.warningTextKey) }}</p>
          <p v-else-if="hud[i].value!.activeSkillBannerKey" class="cue">{{ msg('banners.' + hud[i].value!.activeSkillBannerKey) }}</p>
        </template>
      </section>
    </div>
    <div v-if="stage === 'setup'" class="sheet">
      <div class="briefing">
        <h1>{{ msg('split') }}</h1><p>{{ msg('splitHelp') }}</p>
        <div class="roster">
          <label v-for="i in slots" :key="i">P{{ i + 1 }}
            <select v-model="heroes[i]"><option v-for="id in HERO_IDS" :key="id" :value="id">{{ msg('heroNames.' + id) }}</option></select>
          </label>
        </div>
        <div class="modes"><button v-for="m in (['camera','keyboard'] as const)" :key="m" :aria-pressed="mode === m" @click="mode = m">{{ msg(m === 'camera' ? 'cameraMode' : 'splitKeyboard') }}</button></div>
        <p v-if="mode === 'keyboard'" class="key-help">{{ msg('splitKeys') }}</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <button class="launch" @click="start">{{ msg('startButton') }}</button>
      </div>
    </div>
    <div v-else-if="stage === 'loading' || !pairReady" class="sheet wait">
      <h2>{{ msg(stage === 'loading' ? 'loadingModel' : 'waitingPair') }}</h2>
      <p v-if="stage === 'battle'">P1 {{ tracked[0] ? '✓' : '…' }}　·　P2 {{ tracked[1] ? '✓' : '…' }}</p>
    </div>
    <video v-show="mode === 'camera' && stage !== 'setup' && !pairReady" ref="video" muted autoplay playsinline />
    <button v-if="stage === 'battle'" class="mute" @click="toggleMute">{{ msg(muted ? 'mute' : 'unmute') }}</button>
    <UltraSoundtrack :playing="running" :muted="muted" />
  </main>
</template>

<style scoped>
.split { position: fixed; inset: 0; z-index: 1500; background: #0b1420; color: #f1f7ff; font-family: system-ui,sans-serif; }
header { position: absolute; z-index: 4; inset: 0 0 auto; height: 40px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px; background: #101c29; }
header strong { margin: auto; }
button, select, a { font: inherit; color: inherit; }
button, select { background: #172c3e; border: 1px solid #63859b; border-radius: 7px; padding: .35em .8em; cursor: pointer; }
a { text-decoration: none; }
.boards,.sheet { position: absolute; inset: 40px 0 0; }
.boards { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 3px; background: #a8d4db; }
@media (orientation: portrait) {
  .boards { grid-template-columns: minmax(0,1fr); grid-template-rows: repeat(2,minmax(0,1fr)); }
}
.board { position: relative; overflow: hidden; }
.renderer { position: absolute; inset: 0; }
.sheet { display: grid; place-content: center; text-align: center; background: radial-gradient(ellipse at top,#253e59,#0b1420 74%); padding: 14px; overflow: auto; }
.briefing { max-width: 45em; }
h1 { margin: 0; font-size: clamp(22px,4.3vw,48px); }
.roster,.modes { display: flex; justify-content: center; gap: 14px; margin: 13px 0; }
.roster label { color: #81edff; font-weight: 800; }
.roster label+label { color: #ffd48b; }
select { margin-left: 8px; }
button[aria-pressed=true],.launch { background: #a6edf2; color: #112337; font-weight: 700; }
.launch { padding: .55em 2em; }
.key-help { font-size: .8em; white-space: pre-line; }
.wait { background: #0a1726ce; align-content: start; padding-top: 7vh; pointer-events: none; }
video { position: absolute; left: 50%; top: 53%; transform: translate(-50%,-35%) scaleX(-1); width: min(36vw,280px); max-height: 40vh; border-radius: 8px; }
.hit { position: absolute; pointer-events: none; font: italic 900 clamp(18px,2.4vw,42px)/1 system-ui,sans-serif; text-shadow: 0 2px 4px #191420; animation: rise .85s ease-out forwards; }
@keyframes rise { from { transform: translate(-50%,0) scale(1.15); } to { transform: translate(-50%,-60px); opacity: 0; } }
.meter { position: absolute; top: 9px; left: 3%; right: 3%; background: #081322c9; padding: 7px 11px; display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; border-radius: 8px; }
.meter b { color: #91f4ff; }
.board+section .meter b { color: #ffcf88; }
progress { width: 100%; grid-column: span 2; accent-color: #4ae7ae; height: 7px; }
.cue,.outcome { position: absolute; left: 4%; right: 4%; text-align: center; background: #09182bd9; padding: 8px; border-radius: 8px; }
.cue { bottom: 14%; color: #ffdf83; }.danger { color: #ffad95; }
.outcome { top: 40%; font-size: 1.4em; }.outcome b { display: block; }
.mute { position: absolute; bottom: 8px; left: 12px; }
@media(max-height:450px){ .sheet { place-content: safe center; } .roster,.modes,p { margin: 7px 0; } }
</style>
