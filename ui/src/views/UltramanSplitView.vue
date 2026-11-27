<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRouter } from 'vue-router'
import UltraSoundtrack from '@/components/UltraSoundtrack.vue'
import { HERO_IDS, type HeroId } from '@/games/ultraman/heroes'
import { drawTacticalSkeleton, UltraPoseTracker } from '@/games/ultraman/poseTracker'
import {
  UltramanSplitPvpEngine,
  type PvpFighterHud,
  type PvpHudState,
  type PvpSlot,
} from '@/games/ultraman/pvpEngine'
import type {
  ConcreteSceneTheme,
  ControlMode,
  FloatingDamageEvent,
} from '@/games/ultraman/types'

const router = useRouter()
const { t } = useI18n()
const msg = (key: string, params?: Record<string, unknown>) =>
  params ? t('message.ultramanView.' + key, params) : t('message.ultramanView.' + key)

const stageRef = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const radarCanvasRef = ref<HTMLCanvasElement | null>(null)
let radarCtx: CanvasRenderingContext2D | null = null

const mode = ref<ControlMode>('camera')
const heroes = ref<[HeroId, HeroId]>(['tiga', 'zero'])
const selectedTheme = ref<ConcreteSceneTheme>('city')
const ARENA_THEMES: ConcreteSceneTheme[] = ['city', 'seaside', 'mountain', 'volcano']
const slots: readonly PvpSlot[] = [0, 1]

const foreground = ref(!document.hidden)
const muted = ref(false)
const showSkeleton = ref(true)
const startingCamera = ref(false)
const cameraError = ref('')
const tracked = ref<[boolean, boolean]>([false, false])
const forcePairBypass = ref(false)
const floatingHits = [ref<FloatingDamageEvent[]>([]), ref<FloatingDamageEvent[]>([])] as const
const floatTimers = new Map<number, number>()
const slotFlash = ref<[PvpFighterHud['impactFlashKind'], PvpFighterHud['impactFlashKind']]>([
  'none',
  'none',
])
const slotFlashTimers: [number | null, number | null] = [null, null]

const makeDefaultFighter = (heroId: HeroId): PvpFighterHud => ({
  heroId,
  heroForm: heroId === 'tiga' ? 'multi' : 'base',
  hasForms: heroId === 'tiga' || heroId === 'dyna',
  hp: 150,
  maxHp: 150,
  guardStamina: 100,
  energy: 45,
  combo: 0,
  maxCombo: 0,
  perfectGuards: 0,
  perfectDodges: 0,
  punchChain: 0,
  discCooldownRatio: 0,
  beamCooldownRatio: 0,
  chargeKind: null,
  chargeProgress: 0,
  incomingBeamAlert: false,
  activeBannerKey: null,
  impactFlashKind: 'none',
  impactFlashSeq: 0,
  tracking: false,
  bodyCoverage: 'none',
  distanceHint: 'ok',
  activeGestureCue: 'none',
  mirroredCenterX: 0.5,
  poseHintKey: 'hintStandCenter',
  timerDanger: false,
})

const hud = reactive<PvpHudState>({
  phase: 'menu',
  controlMode: 'camera',
  loadingProgress: 0,
  activeTheme: 'city',
  portraitSplit: false,
  round: 1,
  maxRounds: 3,
  roundTimeLeft: 90,
  wins: [0, 0],
  roundWinner: null,
  matchWinner: null,
  centerBannerKey: null,
  beamClashActive: false,
  beamClashBalance: 0.5,
  fighters: [makeDefaultFighter('tiga'), makeDefaultFighter('zero')],
})

for (const s of [0, 1] as const) {
  watch(
    () => hud.fighters[s].impactFlashSeq,
    () => {
      const kind = hud.fighters[s].impactFlashKind
      if (kind === 'none') return
      slotFlash.value[s] = kind
      if (slotFlashTimers[s] !== null) window.clearTimeout(slotFlashTimers[s]!)
      slotFlashTimers[s] = window.setTimeout(() => {
        slotFlash.value[s] = 'none'
        slotFlashTimers[s] = null
      }, 210)
    },
  )
}

const isBattleStage = computed(
  () =>
    hud.phase === 'round-intro' ||
    hud.phase === 'fighting' ||
    hud.phase === 'round-ko',
)
const pairReady = computed(
  () =>
    mode.value !== 'camera' ||
    forcePairBypass.value ||
    (tracked.value[0] && tracked.value[1]),
)
const needPairWaitOverlay = computed(
  () => isBattleStage.value && mode.value === 'camera' && !pairReady.value,
)
const engineActive = computed(
  () =>
    foreground.value &&
    (hud.phase === 'menu' ||
      hud.phase === 'match-over' ||
      (isBattleStage.value && pairReady.value)),
)

let engine: UltramanSplitPvpEngine | null = null
const tracker = new UltraPoseTracker()
const heldKeys = new Set<string>()

watch(
  engineActive,
  (active) => {
    clearHeldKeys()
    engine?.resetTracking()
    engine?.setPaused(!active)
  },
  { flush: 'sync' },
)

watch(
  () => hud.phase,
  (p) => {
    tracker.setHighIntensityCombat(p === 'fighting')
    if (p === 'match-over' || p === 'menu') {
      tracker.stop(videoRef.value)
      tracked.value = [false, false]
    }
  },
)

tracker.onError = (err) => {
  handleExitToMenu()
  cameraError.value = err instanceof Error ? err.message : String(err)
}

tracker.onPoses = (poses, now, width, height) => {
  if (!foreground.value) return
  const lanes = slots.map((i) => poses.filter((p) => (p.mirroredCenterX < 0.5 ? 0 : 1) === i))
  tracked.value = [lanes[0]!.length >= 1, lanes[1]!.length >= 1]

  const canvas = radarCanvasRef.value
  if (canvas) {
    if (!radarCtx) radarCtx = canvas.getContext('2d')
    if (radarCtx) {
      drawTacticalSkeleton(
        radarCtx,
        canvas.width,
        canvas.height,
        [lanes[0]?.[0]?.landmarks, lanes[1]?.[0]?.landmarks],
        showSkeleton.value,
        true,
        [lanes[0]?.[0]?.leftHandLandmarks, lanes[0]?.[0]?.rightHandLandmarks],
        {
          distanceHint: hud.fighters[0].distanceHint,
          activeCue: hud.fighters[0].activeGestureCue,
          chargeProgress: hud.fighters[0].chargeProgress,
        },
      )
    }
  }

  if (!isBattleStage.value || !pairReady.value) return
  slots.forEach((i) => {
    const pose = lanes[i]?.[0]
    engine?.feedPlayerPose(
      i,
      pose?.landmarks ?? null,
      pose?.worldLandmarks ?? null,
      now,
      width,
      height,
      i === 0 ? 0.75 : 0.25,
      pose
        ? {
            left: pose.leftHandLandmarks,
            leftWorld: pose.leftHandWorldLandmarks,
            right: pose.rightHandLandmarks,
            rightWorld: pose.rightHandWorldLandmarks,
          }
        : null,
    )
  })
}

function selectHero(slot: PvpSlot, id: HeroId) {
  if (heroes.value[slot] === id) return
  heroes.value[slot] = id
  engine?.audio.unlock()
  void engine?.setHero(slot, id)
}

function selectArena(theme: ConcreteSceneTheme) {
  selectedTheme.value = theme
  void engine?.setSceneTheme(theme)
}

function selectMode(nextMode: ControlMode) {
  mode.value = nextMode
  engine?.setControlMode(nextMode)
}

function previewForm(slot: PvpSlot) {
  engine?.audio.unlock()
  engine?.previewNextForm(slot)
}

async function handleStartDuel(overrideMode?: ControlMode) {
  if (!engine || startingCamera.value) return
  if (overrideMode) {
    mode.value = overrideMode
    engine.setControlMode(overrideMode)
  }
  cameraError.value = ''
  forcePairBypass.value = false
  engine.audio.unlock()
  tracker.stop(videoRef.value)

  if (mode.value === 'camera') {
    startingCamera.value = true
    try {
      await tracker.start(videoRef.value!, 2)
    } catch (err) {
      tracker.stop(videoRef.value)
      startingCamera.value = false
      cameraError.value = err instanceof Error ? err.message : String(err)
      return
    }
    startingCamera.value = false
  }

  await engine.startMatch(mode.value, selectedTheme.value)
}

function handleExitToMenu() {
  tracker.stop(videoRef.value)
  clearHeldKeys()
  forcePairBypass.value = false
  tracked.value = [false, false]
  engine?.stopToMenu()
}

function handleGoLobby() {
  handleExitToMenu()
  void router.push('/')
}

function toggleMute() {
  muted.value = !muted.value
  engine?.setMuted(muted.value)
}

function handleRecenter() {
  engine?.recenter()
}

function hpPercent(val: number, max: number) {
  return max > 0 ? Math.max(0, Math.min(100, (val / max) * 100)) : 0
}

// P1 键位：A/D 闪避 · S 护盾 · F/G 出拳 · R 飞踢 · T 光轮 · V 光线 · Q 切形态
// P2 键位：←/→ 闪避 · ↓ 护盾 · J/K 出拳 · I 飞踢 · U 光轮 · L 光线 · O 切形态
const KEY_BINDINGS = [
  ['KeyA', 'KeyD', 'KeyS', 'KeyF', 'KeyG', 'KeyR', 'KeyT', 'KeyV', 'KeyQ'],
  ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'KeyJ', 'KeyK', 'KeyI', 'KeyU', 'KeyL', 'KeyO'],
] as const

function clearHeldKeys() {
  heldKeys.clear()
  if (!engine) return
  for (const s of slots) {
    engine.setManualLean(s, 0)
    engine.setManualGuard(s, false)
  }
}

function handleKeyEvent(e: KeyboardEvent) {
  if (!engine || hud.phase !== 'fighting') return
  slots.forEach((slot) => {
    const bind: readonly string[] = KEY_BINDINGS[slot]
    const actionIdx = bind.indexOf(e.code)
    if (actionIdx < 0) return
    e.preventDefault()

    if (e.type === 'keyup') heldKeys.delete(e.code)
    else heldKeys.add(e.code)

    const left = heldKeys.has(bind[0]!)
    const right = heldKeys.has(bind[1]!)
    engine!.setManualLean(slot, left === right ? 0 : left ? -1 : 1)
    engine!.setManualGuard(slot, heldKeys.has(bind[2]!))

    if (e.type === 'keyup' || e.repeat) return
    if (actionIdx === 3 || actionIdx === 4) {
      engine!.triggerManualPunch(slot, actionIdx === 3 ? 'left' : 'right')
    } else if (actionIdx === 5) {
      engine!.triggerManualKick(slot, 'right')
    } else if (actionIdx === 6) {
      engine!.triggerManualDisc(slot, 'right')
    } else if (actionIdx === 7) {
      engine!.triggerManualBeam(slot)
    } else if (actionIdx === 8) {
      engine!.triggerManualTypeSwitch(slot)
    }
  })
}

function syncVisibility() {
  foreground.value = !document.hidden
  if (!foreground.value) tracked.value = [false, false]
}

onMounted(() => {
  if (!stageRef.value) return
  engine = new UltramanSplitPvpEngine(stageRef.value, {
    onHudUpdate: (next) => {
      Object.assign(hud, next)
    },
    onFloatingText: (slot, evt) => {
      floatingHits[slot].value.push(evt)
      const timer = window.setTimeout(() => {
        floatingHits[slot].value = floatingHits[slot].value.filter((item) => item.id !== evt.id)
        floatTimers.delete(evt.id)
      }, 900)
      floatTimers.set(evt.id, timer)
    },
  })
  void engine.preloadBaseAssets()

  document.addEventListener('visibilitychange', syncVisibility)
  window.addEventListener('blur', clearHeldKeys)
  window.addEventListener('keydown', handleKeyEvent)
  window.addEventListener('keyup', handleKeyEvent)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', syncVisibility)
  window.removeEventListener('blur', clearHeldKeys)
  window.removeEventListener('keydown', handleKeyEvent)
  window.removeEventListener('keyup', handleKeyEvent)
  for (const timer of floatTimers.values()) {
    window.clearTimeout(timer)
  }
  floatTimers.clear()
  tracker.stop(videoRef.value)
  engine?.dispose()
  engine = null
})
</script>

<template>
  <main class="pvp-split-cockpit" :class="{ portrait: hud.portraitSplit }">
    <!-- 顶部防卫队双人对决导航栏 -->
    <header class="pvp-topbar">
      <div class="bar-left">
        <RouterLink to="/ultraman" class="tac-btn" @click="handleExitToMenu">
          ‹ {{ msg('back') }}
        </RouterLink>
        <span class="bar-title">GUTS // {{ msg('split') }}</span>
      </div>
      <div class="bar-right">
        <UltraSoundtrack inline :playing="isBattleStage && pairReady" :muted="muted" />
        <button type="button" class="tac-btn" @click="toggleMute">
          {{ msg(muted ? 'mute' : 'unmute') }}
        </button>
        <button
          v-if="isBattleStage && mode === 'camera'"
          type="button"
          class="tac-btn"
          @click="handleRecenter"
        >
          {{ msg('recenter') }}
        </button>
        <button
          v-if="isBattleStage && mode === 'camera'"
          type="button"
          class="tac-btn"
          :class="{ active: showSkeleton }"
          @click="showSkeleton = !showSkeleton"
        >
          {{ msg('skeleton') }}
        </button>
        <button
          v-if="hud.phase !== 'menu'"
          type="button"
          class="tac-btn danger"
          @click="handleExitToMenu"
        >
          {{ msg('stop') }}
        </button>
      </div>
    </header>

    <!-- 共享单场景双视口 3D WebGL 舞台 -->
    <div ref="stageRef" class="pvp-stage-canvas" />

    <!-- 常驻隐藏/展示摄像头动捕源与雷达画布 -->
    <div
      class="shared-cam-dock"
      :class="{
        'wait-center': needPairWaitOverlay,
        'battle-mini': isBattleStage && mode === 'camera' && pairReady,
      }"
    >
      <video ref="videoRef" muted autoplay playsinline class="cam-video" />
      <canvas ref="radarCanvasRef" width="320" height="240" class="cam-canvas" />
      <div class="cam-lane-tags">
        <span class="cam-tag p1" :class="{ ok: tracked[0] }">P1 {{ tracked[0] ? '✓' : '…' }}</span>
        <span class="cam-tag p2" :class="{ ok: tracked[1] }">P2 {{ tracked[1] ? '✓' : '…' }}</span>
      </div>
    </div>

    <!-- ================= 双人机库整备主菜单（背后实时渲染 P1 VS P2 双雄面对面对峙） ================= -->
    <div v-if="hud.phase === 'menu'" class="pvp-hangar">
      <div class="hangar-columns">
        <!-- 左翼：P1 选人面板 -->
        <aside class="fighter-wing p1-wing">
          <div class="wing-kicker">PLAYER 01 // LEFT VIEWPORT</div>
          <div class="roster-grid">
            <button
              v-for="id in HERO_IDS"
              :key="'p1-' + id"
              type="button"
              class="fighter-card"
              :class="[id, { active: heroes[0] === id }]"
              @click="selectHero(0, id)"
            >
              <div class="card-edge" />
              <div class="card-info">
                <div class="card-top">
                  <strong>{{ msg('heroNames.' + id) }}</strong>
                  <span>{{ id.toUpperCase() }}</span>
                </div>
                <small>{{ msg('heroRoles.' + id) }}</small>
              </div>
            </button>
          </div>
          <div v-if="hud.fighters[0].hasForms" class="wing-form-bar">
            <span class="form-badge" :class="hud.fighters[0].heroForm">
              {{ msg('forms.' + hud.fighters[0].heroForm) }}
            </span>
            <button type="button" class="form-switch-btn" @click="previewForm(0)">
              ↻ {{ msg('switchFormPreview') }}
            </button>
          </div>
        </aside>

        <!-- 中央下沉控制台（不挡上方双雄对峙画面） -->
        <section class="center-console">
          <div class="vs-crest">P1 <span>VS</span> P2</div>
          <p class="pvp-sub">{{ msg('splitHelp') }}</p>

          <!-- 战场选择 -->
          <div class="arena-bar">
            <button
              v-for="th in ARENA_THEMES"
              :key="th"
              type="button"
              class="arena-chip"
              :class="{ active: selectedTheme === th }"
              @click="selectArena(th)"
            >
              {{ msg('arenas.' + th) }}
            </button>
          </div>

          <!-- 模式切换 -->
          <div class="mode-switch-row">
            <button
              type="button"
              class="mode-pill"
              :class="{ active: mode === 'camera' }"
              @click="selectMode('camera')"
            >
              {{ msg('cameraMode') }}
            </button>
            <button
              type="button"
              class="mode-pill"
              :class="{ active: mode === 'keyboard' }"
              @click="selectMode('keyboard')"
            >
              {{ msg('splitKeyboard') }}
            </button>
          </div>

          <pre v-if="mode === 'keyboard'" class="keys-card">{{ msg('splitKeys') }}</pre>

          <div v-if="cameraError" class="cam-error-box" role="alert">
            <span>{{ msg('cameraError') }} {{ cameraError }}</span>
            <button type="button" class="tac-btn warn" @click="handleStartDuel('keyboard')">
              {{ msg('splitKeyboard') }}
            </button>
          </div>

          <button
            type="button"
            class="duel-start-cta"
            :disabled="startingCamera"
            @click="handleStartDuel()"
          >
            {{ startingCamera ? msg('loadingModel') : msg('pvpStartMatch') }}
          </button>
        </section>

        <!-- 右翼：P2 选人面板 -->
        <aside class="fighter-wing p2-wing">
          <div class="wing-kicker">PLAYER 02 // RIGHT VIEWPORT</div>
          <div class="roster-grid">
            <button
              v-for="id in HERO_IDS"
              :key="'p2-' + id"
              type="button"
              class="fighter-card p2"
              :class="[id, { active: heroes[1] === id }]"
              @click="selectHero(1, id)"
            >
              <div class="card-edge" />
              <div class="card-info">
                <div class="card-top">
                  <strong>{{ msg('heroNames.' + id) }}</strong>
                  <span>{{ id.toUpperCase() }}</span>
                </div>
                <small>{{ msg('heroRoles.' + id) }}</small>
              </div>
            </button>
          </div>
          <div v-if="hud.fighters[1].hasForms" class="wing-form-bar">
            <span class="form-badge" :class="hud.fighters[1].heroForm">
              {{ msg('forms.' + hud.fighters[1].heroForm) }}
            </span>
            <button type="button" class="form-switch-btn" @click="previewForm(1)">
              ↻ {{ msg('switchFormPreview') }}
            </button>
          </div>
        </aside>
      </div>
    </div>

    <!-- ================= 加载遮罩 ================= -->
    <div v-if="hud.phase === 'loading'" class="overlay-mask">
      <div class="loading-box">
        <div class="loading-label">{{ msg('loadingModel') }}</div>
        <div class="loading-track">
          <div class="loading-fill" :style="{ width: hud.loadingProgress + '%' }" />
        </div>
      </div>
    </div>

    <!-- ================= 双人体感入镜校准引导层 ================= -->
    <div v-if="needPairWaitOverlay" class="overlay-mask pair-wait-mask">
      <div class="pair-wait-header">
        <h2>{{ msg('waitingPair') }}</h2>
        <p>{{ msg('splitHelp') }}</p>
      </div>
      <div class="pair-wait-footer">
        <button type="button" class="tac-btn accent" @click="forcePairBypass = true">
          {{ msg('forceStartSingle') }}
        </button>
      </div>
    </div>

    <!-- ================= 双人分屏实战对战 HUD ================= -->
    <div v-if="isBattleStage || hud.phase === 'match-over'" class="pvp-battle-hud">
      <!-- 分屏激光分割线 -->
      <div class="split-divider-line" />

      <!-- 顶部中央：三局两胜回合与倒计时记分牌 -->
      <div class="round-scoreboard">
        <div class="win-stars p1">
          <span
            v-for="n in 2"
            :key="'w1-' + n"
            class="star-pip"
            :class="{ earned: n <= hud.wins[0] }"
          />
        </div>
        <div class="clock-core">
          <span class="round-tag">{{ msg('pvpRoundLabel', { round: hud.round }) }}</span>
          <strong class="clock-digits" :class="{ urgent: hud.roundTimeLeft <= 15 }">
            {{ hud.roundTimeLeft }}
          </strong>
        </div>
        <div class="win-stars p2">
          <span
            v-for="n in 2"
            :key="'w2-' + n"
            class="star-pip"
            :class="{ earned: n <= hud.wins[1] }"
          />
        </div>
      </div>

      <!-- 横跨双屏中央：回合开场/胜负大字横幅 -->
      <div v-if="hud.centerBannerKey" :key="hud.centerBannerKey" class="global-cutin">
        {{ msg('banners.' + hud.centerBannerKey) }}
      </div>

      <!-- 横跨双屏中央：P1 VS P2 宿命双光线对波拔河仪 -->
      <div v-if="hud.beamClashActive" class="pvp-clash-meter">
        <div class="clash-title">
          {{ mode === 'keyboard' ? msg('pvpClashKey') : msg('pvpClashCam') }}
        </div>
        <div class="clash-bar-wrap">
          <div
            class="clash-p1-fill"
            :style="{ width: Math.round(hud.beamClashBalance * 100) + '%' }"
          />
          <div
            class="clash-knot"
            :style="{ left: Math.round(hud.beamClashBalance * 100) + '%' }"
          />
        </div>
      </div>

      <!-- P1 与 P2 各自独立半屏视口 HUD -->
      <div class="viewport-grid">
        <section
          v-for="slot in slots"
          :key="'vp-' + slot"
          class="vp-cell"
          :class="'vp-p' + (slot + 1)"
        >
          <!-- 分屏独立视觉冲击边光 -->
          <div
            v-if="slotFlash[slot] !== 'none'"
            :key="'fx-' + hud.fighters[slot].impactFlashSeq"
            class="vp-impact-fx"
            :class="slotFlash[slot]"
            aria-hidden="true"
          />

          <!-- 本视口独立伤害/特技飘字 -->
          <div class="vp-floating-layer" aria-hidden="true">
            <span
              v-for="evt in floatingHits[slot].value"
              :key="evt.id"
              class="vp-float"
              :class="evt.kind"
              :style="{
                left: evt.x + '%',
                top: evt.y + '%',
                color: evt.color,
                '--fscale': evt.scale,
                '--drift-x': (evt.driftX ?? 0) + 'px',
              }"
            >
              {{ evt.text }}
            </span>
          </div>

          <!-- 视口顶部：锁定对面敌方玩家的装甲血条 -->
          <div class="enemy-target-bar">
            <div class="enemy-meta">
              <span class="target-tag">
                ⊕ {{ msg('pvpTargetEnemy') }} · P{{ slot === 0 ? 2 : 1 }}
                {{ msg('heroNames.' + hud.fighters[1 - slot]!.heroId) }}
              </span>
              <span class="enemy-hp-num">
                {{ hud.fighters[1 - slot]!.hp }} / {{ hud.fighters[1 - slot]!.maxHp }}
              </span>
            </div>
            <div class="armor-track enemy">
              <div
                class="armor-trail"
                :style="{
                  width:
                    hpPercent(hud.fighters[1 - slot]!.hp, hud.fighters[1 - slot]!.maxHp) + '%',
                }"
              />
              <div
                class="armor-fill enemy"
                :style="{
                  width:
                    hpPercent(hud.fighters[1 - slot]!.hp, hud.fighters[1 - slot]!.maxHp) + '%',
                }"
              />
            </div>
          </div>

          <!-- 对手发射必杀光线反制预警 / 单侧招式播报 -->
          <div v-if="hud.fighters[slot].incomingBeamAlert" class="incoming-ray-alert">
            {{ mode === 'keyboard' ? msg('pvpIncomingBeamKey') : msg('pvpIncomingBeamCam') }}
          </div>
          <div
            v-else-if="hud.fighters[slot].activeBannerKey"
            :key="hud.fighters[slot].activeBannerKey!"
            class="vp-skill-banner"
          >
            {{ msg('banners.' + hud.fighters[slot].activeBannerKey) }}
          </div>

          <!-- 视口左下：本侧玩家自身彩色计时器 + 装甲血条 + 光之能量刻度条 -->
          <div class="self-status-panel">
            <div
              class="self-color-timer"
              :class="[
                hud.fighters[slot].heroId,
                { danger: hud.fighters[slot].timerDanger },
              ]"
            >
              <div class="timer-gem" />
            </div>

            <div class="self-bars">
              <div class="self-head">
                <span class="self-name">
                  <b>P{{ slot + 1 }}</b>
                  {{ msg('heroNames.' + hud.fighters[slot].heroId) }}
                  <em
                    v-if="hud.fighters[slot].hasForms"
                    class="form-badge mini"
                    :class="hud.fighters[slot].heroForm"
                  >
                    {{ msg('forms.' + hud.fighters[slot].heroForm) }}
                  </em>
                </span>
                <span class="self-hp-val">
                  {{ hud.fighters[slot].hp }} / {{ hud.fighters[slot].maxHp }}
                </span>
              </div>

              <div class="armor-track self">
                <div
                  class="armor-trail"
                  :style="{
                    width: hpPercent(hud.fighters[slot].hp, hud.fighters[slot].maxHp) + '%',
                  }"
                />
                <div
                  class="armor-fill self"
                  :class="{ danger: hud.fighters[slot].timerDanger }"
                  :style="{
                    width: hpPercent(hud.fighters[slot].hp, hud.fighters[slot].maxHp) + '%',
                  }"
                />
              </div>

              <div v-if="hud.fighters[slot].punchChain > 0" class="self-chain">
                <span>{{ msg('chainCue') }}</span>
                <i
                  v-for="n in 3"
                  :key="n"
                  :class="{ lit: n <= hud.fighters[slot].punchChain }"
                />
              </div>

              <div class="energy-track-pvp">
                <div class="energy-mark" style="left: 35%" />
                <div
                  class="energy-fill-pvp"
                  :class="{
                    ready: hud.fighters[slot].energy >= 35,
                    full: hud.fighters[slot].energy >= 100,
                  }"
                  :style="{ width: hud.fighters[slot].energy + '%' }"
                />
              </div>

              <div class="pvp-shield-row">
                <span class="pvp-shield-lbl">{{ msg('guardStamina') }}</span>
                <div class="pvp-shield-track">
                  <div
                    class="pvp-shield-fill"
                    :class="{ low: hud.fighters[slot].guardStamina < 28 }"
                    :style="{ width: hud.fighters[slot].guardStamina + '%' }"
                  />
                </div>
              </div>
            </div>

            <div v-if="hud.fighters[slot].combo >= 2" class="self-combo-chip">
              {{ hud.fighters[slot].combo }}×
            </div>
          </div>
        </section>
      </div>
    </div>

    <!-- ================= 三局两胜终局结算面板 ================= -->
    <div v-if="hud.phase === 'match-over'" class="overlay-mask match-result-mask">
      <div class="match-result-card">
        <div class="result-kicker">GUTS VERSUS CHAMPIONSHIP</div>
        <h2 class="result-winner-title">
          {{
            msg(
              hud.matchWinner === 0
                ? 'banners.bannerPvpMatchWinP1'
                : 'banners.bannerPvpMatchWinP2',
            )
          }}
        </h2>

        <div class="versus-score-summary">
          <div class="summary-col p1" :class="{ champ: hud.matchWinner === 0 }">
            <div class="col-tag">P1 · {{ msg('heroNames.' + hud.fighters[0].heroId) }}</div>
            <div class="col-wins">{{ hud.wins[0] }}</div>
            <div class="col-meta">
              {{ msg('result.maxCombo') }} {{ hud.fighters[0].maxCombo }} ·
              {{ msg('result.perfectGuards') }} {{ hud.fighters[0].perfectGuards }} ·
              {{ msg('result.perfectDodges') }} {{ hud.fighters[0].perfectDodges }}
            </div>
          </div>
          <div class="summary-sep">:</div>
          <div class="summary-col p2" :class="{ champ: hud.matchWinner === 1 }">
            <div class="col-tag">P2 · {{ msg('heroNames.' + hud.fighters[1].heroId) }}</div>
            <div class="col-wins">{{ hud.wins[1] }}</div>
            <div class="col-meta">
              {{ msg('result.maxCombo') }} {{ hud.fighters[1].maxCombo }} ·
              {{ msg('result.perfectGuards') }} {{ hud.fighters[1].perfectGuards }} ·
              {{ msg('result.perfectDodges') }} {{ hud.fighters[1].perfectDodges }}
            </div>
          </div>
        </div>

        <div class="result-actions">
          <button type="button" class="duel-start-cta compact" @click="handleStartDuel()">
            {{ msg('pvpRematch') }}
          </button>
          <button type="button" class="tac-btn large" @click="handleExitToMenu">
            {{ msg('result.backMenu') }}
          </button>
          <button type="button" class="tac-btn large" @click="handleGoLobby">
            {{ msg('result.backHome') }}
          </button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.pvp-split-cockpit {
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: #060f1d;
  color: #f1f7ff;
  font-family: 'Bahnschrift', 'DIN Alternate', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-variant-numeric: tabular-nums;
  user-select: none;
  overflow: hidden;
}

.pvp-topbar {
  position: absolute;
  z-index: 50;
  inset: 0 0 auto;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: rgba(6, 14, 26, 0.94);
  border-bottom: 1px solid rgba(56, 232, 255, 0.35);
}

.bar-left,
.bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar-title {
  font-size: 14px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 1.5px;
  color: #38e8ff;
}

.tac-btn {
  display: inline-flex;
  align-items: center;
  padding: 5px 12px;
  background: rgba(12, 25, 44, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.42);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: #e2f1ff;
  font-size: 12px;
  font-weight: 800;
  text-decoration: none;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.tac-btn:hover,
.tac-btn.active {
  border-color: #38e8ff;
  color: #7dd3fc;
}

.tac-btn.accent {
  border-color: #38e8ff;
  background: rgba(14, 65, 98, 0.9);
  color: #bae6fd;
  padding: 8px 20px;
}

.tac-btn.danger {
  border-color: rgba(248, 113, 113, 0.75);
  background: rgba(127, 29, 29, 0.85);
  color: #fecaca;
}

.tac-btn.warn {
  background: #facc15;
  border-color: #fef08a;
  color: #050d1a;
}

.tac-btn.large {
  padding: 11px 22px;
  font-size: 13px;
}

/* 共享全屏 3D 舞台 */
.pvp-stage-canvas {
  position: absolute;
  inset: 46px 0 0;
}

/* 摄像头与双色骨骼雷达窗（支持入镜等待居中大窗 & 战斗底部中央迷你窗无缝过渡） */
.shared-cam-dock {
  position: fixed;
  left: 50%;
  bottom: 12px;
  width: 176px;
  aspect-ratio: 4 / 3;
  transform: translateX(-50%) translateY(20px);
  background: rgba(6, 14, 26, 0.92);
  border: 1.5px solid rgba(56, 232, 255, 0.65);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.65);
  z-index: 44;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
  transition: all 0.24s ease;
}

.shared-cam-dock.battle-mini {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

.shared-cam-dock.wait-center {
  opacity: 1;
  bottom: auto;
  top: 52%;
  width: min(400px, 86vw);
  transform: translate(-50%, -50%);
  z-index: 48;
}

.cam-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.cam-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.cam-lane-tags {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  justify-content: space-between;
  padding: 3px 8px;
  background: rgba(5, 11, 22, 0.85);
  font-size: 10px;
  font-weight: 900;
}

.cam-tag.p1 {
  color: #94a3b8;
}
.cam-tag.p1.ok {
  color: #38e8ff;
}
.cam-tag.p2 {
  color: #94a3b8;
}
.cam-tag.p2.ok {
  color: #fb923c;
}

/* ================= 双人机库整备主菜单 ================= */
.pvp-hangar {
  position: absolute;
  inset: 46px 0 0;
  z-index: 38;
  padding: 16px 20px 18px;
  pointer-events: none;
  background:
    linear-gradient(
      90deg,
      rgba(5, 11, 22, 0.85) 0%,
      rgba(5, 11, 22, 0.15) 26%,
      rgba(5, 11, 22, 0.15) 74%,
      rgba(5, 11, 22, 0.85) 100%
    ),
    linear-gradient(180deg, transparent 55%, rgba(5, 11, 22, 0.88) 100%);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.hangar-columns {
  display: grid;
  grid-template-columns: minmax(210px, 265px) 1fr minmax(210px, 265px);
  align-items: end;
  gap: 16px;
  height: 100%;
}

.fighter-wing {
  align-self: center;
  pointer-events: auto;
  padding: 14px;
  background: rgba(8, 17, 32, 0.82);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(56, 232, 255, 0.42);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
}

.p1-wing {
  clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%);
}

.p2-wing {
  border-color: rgba(251, 146, 60, 0.48);
  clip-path: polygon(12px 0, 100% 0, 100% 100%, 0 100%, 0 12px);
}

.wing-kicker {
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 1.5px;
  color: #38e8ff;
  margin-bottom: 10px;
}

.p2-wing .wing-kicker {
  color: #fb923c;
}

.roster-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fighter-card {
  display: flex;
  align-items: stretch;
  padding: 9px 11px;
  background: rgba(15, 28, 48, 0.78);
  border: 1px solid rgba(148, 163, 184, 0.25);
  color: #e2e8f0;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}

.fighter-card:hover {
  border-color: rgba(125, 211, 252, 0.6);
}

.card-edge {
  width: 4px;
  margin-right: 10px;
  background: #475569;
}

.fighter-card.active {
  border-color: #38e8ff;
  background: linear-gradient(90deg, rgba(56, 232, 255, 0.22), rgba(15, 28, 48, 0.85));
}

.fighter-card.active .card-edge {
  background: #38e8ff;
  box-shadow: 0 0 10px #38e8ff;
}

.fighter-card.p2.active {
  border-color: #fb923c;
  background: linear-gradient(90deg, rgba(251, 146, 60, 0.24), rgba(15, 28, 48, 0.85));
}

.fighter-card.p2.active .card-edge {
  background: #fb923c;
  box-shadow: 0 0 10px #fb923c;
}

.card-info {
  flex: 1;
  min-width: 0;
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.card-top strong {
  font-size: 15px;
  color: #ffffff;
}

.card-top span {
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 1px;
  color: #94a3b8;
}

.card-info small {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  color: #94a3b8;
}

.wing-form-bar {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(148, 163, 184, 0.2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.form-badge {
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 900;
  background: rgba(56, 232, 255, 0.18);
  border: 1px solid rgba(56, 232, 255, 0.65);
  color: #7dd3fc;
  font-style: normal;
}

.form-badge.mini {
  margin-left: 5px;
  padding: 1px 6px;
  font-size: 9px;
}

.form-badge.power,
.form-badge.strong {
  background: rgba(239, 68, 68, 0.24);
  border-color: #fb7185;
  color: #fecdd3;
}

.form-badge.sky {
  background: rgba(168, 85, 247, 0.24);
  border-color: #c084fc;
  color: #e9d5ff;
}

.form-badge.miracle {
  background: rgba(14, 165, 233, 0.24);
  border-color: #38bdf8;
  color: #bae6fd;
}

.form-switch-btn {
  padding: 3px 9px;
  background: rgba(250, 204, 21, 0.14);
  border: 1px solid rgba(250, 204, 21, 0.65);
  color: #fef08a;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}

/* 中央底部控制台 */
.center-console {
  pointer-events: auto;
  justify-self: center;
  width: min(520px, 100%);
  padding: 12px 18px 14px;
  background: rgba(7, 16, 30, 0.86);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(56, 232, 255, 0.4);
  clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%, 0 14px);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.vs-crest {
  font-size: 20px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 3px;
  color: #38e8ff;
}

.vs-crest span {
  color: #facc15;
  font-size: 24px;
  margin: 0 6px;
}

.pvp-sub {
  margin: 0;
  font-size: 11px;
  color: #cbd5e1;
}

.arena-bar,
.mode-switch-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.arena-chip {
  padding: 4px 10px;
  background: rgba(15, 28, 48, 0.8);
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}

.arena-chip.active {
  border-color: #facc15;
  background: rgba(250, 204, 21, 0.18);
  color: #fef08a;
}

.mode-pill {
  padding: 6px 14px;
  background: rgba(15, 28, 48, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.35);
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.mode-pill.active {
  background: linear-gradient(90deg, #38e8ff, #60a5fa);
  border-color: #38e8ff;
  color: #050d1a;
}

.keys-card {
  margin: 0;
  padding: 6px 10px;
  width: 100%;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.25);
  font-family: inherit;
  font-size: 10px;
  line-height: 1.45;
  color: #cbd5e1;
  white-space: pre-wrap;
}

.cam-error-box {
  padding: 8px 12px;
  background: rgba(153, 27, 27, 0.45);
  border: 1px solid #f87171;
  font-size: 11px;
  color: #fecaca;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.duel-start-cta {
  padding: 11px 36px;
  border: none;
  clip-path: polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%);
  background: linear-gradient(95deg, #38e8ff 0%, #facc15 50%, #fb923c 100%);
  color: #050d1a;
  font-size: 16px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 1.8px;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(56, 232, 255, 0.4);
}

.duel-start-cta.compact {
  padding: 11px 28px;
  font-size: 14px;
}

/* ================= 双人分屏战斗 HUD ================= */
.pvp-battle-hud {
  position: absolute;
  inset: 46px 0 0;
  z-index: 32;
  pointer-events: none;
}

.split-divider-line {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 3px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, #38e8ff, #facc15, #fb923c);
  box-shadow: 0 0 14px rgba(56, 232, 255, 0.8);
  z-index: 20;
}

.pvp-split-cockpit.portrait .split-divider-line {
  top: 50%;
  bottom: auto;
  left: 0;
  right: 0;
  width: auto;
  height: 3px;
  transform: translateY(-50%);
  background: linear-gradient(90deg, #38e8ff, #facc15, #fb923c);
}

/* 顶部中央回合计分仪 */
.round-scoreboard {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 26;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 5px 18px;
  background: rgba(6, 14, 26, 0.94);
  border: 1.5px solid rgba(250, 204, 21, 0.7);
  clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 100%, 0 100%);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
}

.pvp-split-cockpit.portrait .round-scoreboard {
  top: 50%;
  transform: translate(-50%, -50%);
}

.win-stars {
  display: flex;
  gap: 5px;
}

.star-pip {
  width: 12px;
  height: 12px;
  transform: rotate(45deg);
  border: 1.5px solid #64748b;
  background: rgba(15, 23, 42, 0.8);
}

.win-stars.p1 .star-pip.earned {
  border-color: #38e8ff;
  background: #38e8ff;
  box-shadow: 0 0 10px #38e8ff;
}

.win-stars.p2 .star-pip.earned {
  border-color: #fb923c;
  background: #fb923c;
  box-shadow: 0 0 10px #fb923c;
}

.clock-core {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 68px;
}

.round-tag {
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 1.2px;
  color: #94a3b8;
}

.clock-digits {
  font-size: 20px;
  font-weight: 900;
  line-height: 1.05;
  color: #fef08a;
}

.clock-digits.urgent {
  color: #f87171;
  animation: blinkFast 0.45s infinite alternate;
}

@keyframes blinkFast {
  from {
    opacity: 1;
  }
  to {
    opacity: 0.45;
  }
}

/* 横跨双屏全局大字播报与对波条 */
.global-cutin {
  position: absolute;
  top: 76px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 28;
  padding: 7px 28px;
  background: linear-gradient(95deg, rgba(8, 47, 73, 0.95), rgba(30, 64, 175, 0.95));
  border-top: 2px solid #fef08a;
  border-bottom: 2px solid #38e8ff;
  clip-path: polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%);
  font-size: clamp(18px, 2.4vw, 26px);
  font-weight: 900;
  font-style: italic;
  letter-spacing: 2px;
  color: #fef9c3;
  white-space: nowrap;
}

.pvp-clash-meter {
  position: absolute;
  top: 126px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 29;
  width: min(560px, 90vw);
  padding: 9px 16px 12px;
  background: rgba(8, 15, 28, 0.94);
  border: 2px solid #facc15;
  box-shadow: 0 0 32px rgba(250, 204, 21, 0.7);
  text-align: center;
}

.clash-title {
  font-size: 13px;
  font-weight: 900;
  color: #fef08a;
  margin-bottom: 7px;
}

.clash-bar-wrap {
  position: relative;
  height: 14px;
  background: linear-gradient(90deg, #ea580c, #fbbf24);
  border: 1px solid #ffffff;
}

.clash-p1-fill {
  height: 100%;
  background: linear-gradient(90deg, #0284c7, #38e8ff);
  transition: width 0.05s linear;
}

.clash-knot {
  position: absolute;
  top: 50%;
  width: 20px;
  height: 20px;
  transform: translate(-50%, -50%) rotate(45deg);
  background: #ffffff;
  border: 2px solid #facc15;
  box-shadow: 0 0 18px #ffffff;
}

/* 双视口网格 */
.viewport-grid {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.pvp-split-cockpit.portrait .viewport-grid {
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: repeat(2, minmax(0, 1fr));
}

.vp-cell {
  position: relative;
  overflow: hidden;
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.vp-floating-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 15;
}

.vp-float {
  position: absolute;
  font-size: 24px;
  font-weight: 900;
  font-style: italic;
  text-shadow: 0 3px 0 #020617, 0 0 12px rgba(0, 0, 0, 0.88);
  animation: vpFloatUp 0.88s ease-out forwards;
  white-space: nowrap;
}

@keyframes vpFloatUp {
  0% {
    opacity: 0;
    transform: translate(-50%, -20%) scale(calc(var(--fscale, 1) * 0.7));
  }
  18% {
    opacity: 1;
    transform: translate(calc(-50% + var(--drift-x, 0px) * 0.35), -65%)
      scale(calc(var(--fscale, 1) * 1.15));
  }
  100% {
    opacity: 0;
    transform: translate(calc(-50% + var(--drift-x, 0px)), -165%) scale(var(--fscale, 1));
  }
}

/* 视口顶部敌方目标血条（避开中央记分牌） */
.enemy-target-bar {
  width: min(310px, calc(100% - 92px));
  padding: 6px 12px 8px;
  background: rgba(8, 17, 32, 0.85);
  border: 1px solid rgba(248, 113, 113, 0.58);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
}

.vp-p2 .enemy-target-bar {
  align-self: flex-end;
}

.enemy-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 900;
  margin-bottom: 4px;
}

.target-tag {
  color: #fca5a5;
}

.enemy-hp-num {
  color: #fecaca;
}

.armor-track {
  position: relative;
  height: 9px;
  background: rgba(2, 6, 23, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.22);
  transform: skewX(-14deg);
  overflow: hidden;
}

.armor-trail {
  position: absolute;
  inset: 0 auto 0 0;
  background: #fef08a;
  transition: width 0.6s ease 0.1s;
}

.armor-fill {
  position: relative;
  height: 100%;
  transition: width 0.12s ease-out;
}

.armor-fill.enemy {
  background: linear-gradient(90deg, #b91c1c, #ef4444, #fb923c);
}

.armor-fill.self {
  background: linear-gradient(90deg, #0284c7, #38e8ff);
}

.vp-p2 .armor-fill.self {
  background: linear-gradient(90deg, #ea580c, #fbbf24);
}

.armor-fill.self.danger {
  background: linear-gradient(90deg, #dc2626, #f97316);
}

.incoming-ray-alert {
  align-self: center;
  padding: 6px 14px;
  background: rgba(185, 28, 28, 0.92);
  border: 1.5px solid #fde047;
  font-size: 12px;
  font-weight: 900;
  color: #ffffff;
  text-align: center;
  animation: blinkFast 0.35s infinite alternate;
}

.vp-skill-banner {
  align-self: center;
  padding: 5px 18px;
  background: rgba(12, 34, 62, 0.9);
  border: 1px solid #38e8ff;
  clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  font-size: 15px;
  font-weight: 900;
  font-style: italic;
  color: #fef08a;
}

/* 视口左下玩家自身装甲与光能舱 */
.self-status-panel {
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(300px, calc(100% - 20px));
  padding: 9px 12px;
  background: rgba(8, 17, 32, 0.88);
  border: 1.5px solid rgba(56, 232, 255, 0.58);
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
}

.vp-p2 .self-status-panel {
  align-self: flex-end;
  border-color: rgba(251, 146, 60, 0.65);
}

.self-color-timer {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle, #7dd3fc 0%, #0284c7 65%, #082f49 100%);
  border: 2px solid #e2e8f0;
  box-shadow: 0 0 14px rgba(56, 232, 255, 0.85);
}

.self-color-timer.zero {
  background: radial-gradient(circle, #ccfbf1 0%, #14b8a6 62%, #0f172a 100%);
}

.self-color-timer.danger {
  background: radial-gradient(circle, #fecaca 0%, #dc2626 65%, #450a0a 100%);
  box-shadow: 0 0 18px #ef4444;
  animation: blinkFast 0.45s infinite alternate;
}

.timer-gem {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f0f9ff;
}

.self-bars {
  flex: 1;
  min-width: 0;
}

.self-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 800;
  margin-bottom: 3px;
}

.self-name b {
  color: #38e8ff;
  margin-right: 4px;
}

.vp-p2 .self-name b {
  color: #fb923c;
}

.self-hp-val {
  color: #bae6fd;
}

.self-chain {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 9px;
  font-weight: 900;
  color: #fde047;
}

.self-chain i {
  width: 12px;
  height: 4px;
  transform: skewX(-18deg);
  background: rgba(148, 163, 184, 0.3);
}

.self-chain i.lit {
  background: #facc15;
}

.energy-track-pvp {
  position: relative;
  height: 7px;
  margin-top: 5px;
  background: rgba(2, 6, 23, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.18);
  transform: skewX(-14deg);
  overflow: hidden;
}

.energy-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: rgba(255, 255, 255, 0.7);
  z-index: 2;
}

.energy-fill-pvp {
  height: 100%;
  background: #475569;
  transition: width 0.14s;
}

.energy-fill-pvp.ready {
  background: linear-gradient(90deg, #0284c7, #38e8ff);
}

.energy-fill-pvp.full {
  background: linear-gradient(90deg, #38e8ff, #facc15, #fb923c);
}

.self-combo-chip {
  padding: 3px 8px;
  background: #facc15;
  color: #050d1a;
  font-size: 13px;
  font-weight: 900;
  font-style: italic;
}

/* ================= 遮罩与终局结算 ================= */
.overlay-mask {
  position: absolute;
  inset: 46px 0 0;
  z-index: 42;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(4, 10, 22, 0.78);
  backdrop-filter: blur(6px);
}

.pair-wait-mask {
  justify-content: space-between;
  padding: 28px 20px 36px;
}

.pair-wait-header {
  text-align: center;
}

.pair-wait-header h2 {
  margin: 0 0 6px;
  font-size: 22px;
}

.pair-wait-header p {
  margin: 0;
  font-size: 13px;
  color: #94a3b8;
}

.loading-box {
  width: min(340px, 84vw);
  padding: 22px;
  background: rgba(9, 19, 36, 0.95);
  border: 1.5px solid #38e8ff;
  text-align: center;
}

.loading-label {
  font-size: 15px;
  font-weight: 800;
  margin-bottom: 12px;
}

.loading-track {
  height: 10px;
  background: rgba(255, 255, 255, 0.15);
}

.loading-fill {
  height: 100%;
  background: linear-gradient(90deg, #38e8ff, #facc15);
}

.match-result-card {
  width: min(560px, 92vw);
  padding: 28px 30px;
  background: rgba(8, 18, 34, 0.95);
  border: 2px solid #facc15;
  clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.72);
  text-align: center;
}

.result-kicker {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #38e8ff;
}

.result-winner-title {
  margin: 6px 0 22px;
  font-size: 28px;
  font-weight: 900;
  font-style: italic;
  color: #fef08a;
}

.versus-score-summary {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.summary-col {
  padding: 14px;
  background: rgba(15, 28, 48, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.3);
}

.summary-col.champ {
  border-color: #facc15;
  background: rgba(250, 204, 21, 0.12);
}

.col-tag {
  font-size: 13px;
  font-weight: 900;
  color: #e2e8f0;
}

.col-wins {
  font-size: 38px;
  font-weight: 900;
  color: #fde047;
  line-height: 1.1;
  margin: 6px 0;
}

.col-meta {
  font-size: 11px;
  color: #94a3b8;
}

.summary-sep {
  font-size: 32px;
  font-weight: 900;
  color: #64748b;
}

.result-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
}

.vp-impact-fx {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 25;
  animation: vpEdgeFlash 0.21s ease-out forwards;
}
.vp-impact-fx.heavy {
  box-shadow: inset 0 0 64px rgba(250, 204, 21, 0.55);
}
.vp-impact-fx.parry {
  box-shadow: inset 0 0 72px rgba(56, 232, 255, 0.65);
}
.vp-impact-fx.dodge {
  box-shadow: inset 0 0 72px rgba(74, 222, 128, 0.58);
}
.vp-impact-fx.hurt {
  box-shadow: inset 0 0 78px rgba(239, 68, 68, 0.72);
}
@keyframes vpEdgeFlash {
  0% { opacity: 1; }
  100% { opacity: 0; }
}

.pvp-shield-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.pvp-shield-lbl {
  font-size: 9px;
  font-weight: 800;
  color: #93c5fd;
  white-space: nowrap;
}
.pvp-shield-track {
  flex: 1;
  height: 4px;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(96, 165, 250, 0.3);
  overflow: hidden;
}
.pvp-shield-fill {
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #a5f3fc);
  transition: width 0.08s linear;
}
.pvp-shield-fill.low {
  background: linear-gradient(90deg, #ef4444, #fb923c);
}

@media (max-width: 900px) {
  .hangar-columns {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .roster-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
