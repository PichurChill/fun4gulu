<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { UltramanGameEngine } from '@/games/ultraman/engine'
import UltraSoundtrack from '@/components/UltraSoundtrack.vue'
import { HERO_IDS, HERO_PROFILES } from '@/games/ultraman/heroes'
import { MONSTER_WAVES } from '@/games/ultraman/monsters'
import { drawTacticalSkeleton, UltraPoseTracker } from '@/games/ultraman/poseTracker'
import type {
  BattleHudState,
  ConcreteSceneTheme,
  ControlMode,
  FloatingDamageEvent,
  HeroId,
  SceneTheme,
} from '@/games/ultraman/types'

const router = useRouter()
const { t } = useI18n()

// ---- DOM 引用 ----
const stageRef = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const poseCanvasRef = ref<HTMLCanvasElement | null>(null)

// ---- 交互与配置状态 ----
const selectedMode = ref<ControlMode>('camera')
const selectedHero = ref<HeroId>('tiga')
const selectedWave = ref(0)
const selectedTheme = ref<SceneTheme>('auto')
const SCENE_THEMES: SceneTheme[] = ['auto', 'seaside', 'city', 'mountain', 'volcano']
const CONCRETE_THEMES: ConcreteSceneTheme[] = ['seaside', 'city', 'mountain', 'volcano']
const muted = ref(false)
const showSkeleton = ref(true)
const radarExpanded = ref(false)
const showGuide = ref(false)
const cameraError = ref<string | null>(null)
const startingCamera = ref(false)
const floatingEvents = ref<FloatingDamageEvent[]>([])

const hud = reactive<BattleHudState>({
  phase: 'menu',
  controlMode: 'camera',
  loadingProgress: 0,
  heroId: 'tiga',
  heroForm: 'multi',
  hasForms: true,
  waveIndex: 0,
  totalWaves: MONSTER_WAVES.length,
  activeTheme: 'seaside',
  monsterState: 'idle',
  monsterId: MONSTER_WAVES[0]!.id,
  monsterHp: MONSTER_WAVES[0]!.maxHp,
  monsterMaxHp: MONSTER_WAVES[0]!.maxHp,
  heroHp: 100,
  heroMaxHp: 100,
  energy: 50,
  score: 0,
  punchChain: 0,
  combo: 0,
  maxCombo: 0,
  perfectGuards: 0,
  defeatedCount: 0,
  warningTextKey: null,
  warningUrgency: 0,
  chargeKind: null,
  chargeProgress: 0,
  discCooldownRatio: 0,
  beamCooldownRatio: 0,
  beamClashActive: false,
  beamClashProgress: 0.5,
  activeSkillBannerKey: null,
  tracking: false,
  bodyCoverage: 'none',
  mirroredCenterX: 0.5,
  poseHintKey: 'hintStandCenter',
  timerDanger: false,
})

const monsterHpPercent = computed(() =>
  hud.monsterMaxHp > 0 ? Math.max(0, Math.min(100, (hud.monsterHp / hud.monsterMaxHp) * 100)) : 0,
)
const heroHpPercent = computed(() =>
  hud.heroMaxHp > 0 ? Math.max(0, Math.min(100, (hud.heroHp / hud.heroMaxHp) * 100)) : 0,
)
const currentMonsterName = computed(() => t(`message.ultramanView.monsters.${hud.monsterId}`))
const heroHpLabel = computed(
  () => `${t(`message.ultramanView.heroNames.${hud.heroId}`)} · ${t('message.ultramanView.heroHpSuffix')}`,
)
const isPlaying = computed(
  () => hud.phase === 'intro' || hud.phase === 'fighting' || hud.phase === 'wave-clear',
)
const activeHeroHex = computed(() => HERO_PROFILES[hud.heroId]?.uiHex ?? '#38e8ff')

const warningMessage = computed(() => {
  if (!hud.warningTextKey) return ''
  const group = selectedMode.value === 'keyboard' ? 'warningsKey' : 'warnings'
  return t(`message.ultramanView.${group}.${hud.warningTextKey}`)
})

const energyStatusText = computed(() => {
  const isKey = selectedMode.value === 'keyboard'
  if (hud.energy >= 100) {
    return t(`message.ultramanView.${isKey ? 'energyFullKey' : 'energyFull'}`)
  }
  if (hud.energy >= 35) {
    return t(`message.ultramanView.${isKey ? 'energyReadyKey' : 'energyReady'}`)
  }
  return `${hud.energy}%`
})

const moveGuideItems = computed(() => {
  const prefix = selectedMode.value === 'keyboard' ? 'keyMoves' : 'moves'
  const keys = ['punch', 'jump', 'dodge', 'guard', 'disc', ...(hud.hasForms ? ['form'] : []), 'beam']
  return keys.map((k) => ({
    key: k,
    name: t(`message.ultramanView.${prefix}.${k}`),
    desc: t(`message.ultramanView.${prefix}.${k}Desc`),
    isUltimate: k === 'beam',
  }))
})

// ---- 运行时句柄 ----
let engine: UltramanGameEngine | null = null
const poseTracker = new UltraPoseTracker()
let poseCtx: CanvasRenderingContext2D | null = null
const pressedKeys = new Set<string>()
const floatTimers = new Map<number, number>()

poseTracker.onPoses = (poses, now, width, height) => {
  const primary = poses[0] ?? null
  const canvas = poseCanvasRef.value
  if (canvas) {
    if (!poseCtx) poseCtx = canvas.getContext('2d')
    if (poseCtx) {
      drawTacticalSkeleton(
        poseCtx,
        canvas.width,
        canvas.height,
        [primary?.landmarks],
        showSkeleton.value,
      )
    }
  }
  engine?.feedPoseLandmarks(
    primary?.landmarks ?? null,
    primary?.worldLandmarks ?? null,
    now,
    width,
    height,
  )
}

poseTracker.onError = (err) => {
  handleExitToMenu()
  cameraError.value = err instanceof Error ? err.message : String(err)
}

function stopCameraTracking() {
  poseTracker.stop(videoRef.value)
  if (poseCtx && poseCanvasRef.value) {
    poseCtx.clearRect(0, 0, poseCanvasRef.value.width, poseCanvasRef.value.height)
  }
}

function selectHero(id: HeroId) {
  if (selectedHero.value === id) return
  selectedHero.value = id
  engine?.audio.unlock()
  void engine?.setHero(id)
}

function selectControlMode(mode: ControlMode) {
  selectedMode.value = mode
  engine?.setControlMode(mode)
}

function selectWave(idx: number) {
  selectedWave.value = idx
  void engine?.previewWave(idx)
}

function selectSceneTheme(theme: SceneTheme) {
  selectedTheme.value = theme
  void engine?.setSceneTheme(theme, selectedWave.value)
}

function cycleActiveArena() {
  const curIdx = CONCRETE_THEMES.indexOf(hud.activeTheme)
  const next = CONCRETE_THEMES[(curIdx + 1) % CONCRETE_THEMES.length]!
  selectedTheme.value = next
  void engine?.setSceneTheme(next, hud.waveIndex)
}

function handlePreviewForm() {
  engine?.audio.unlock()
  engine?.previewNextForm()
}

// ---- 游戏流程控制 ----
async function handleStartBattle(overrideMode?: ControlMode) {
  if (!engine || startingCamera.value) return
  if (overrideMode) {
    selectedMode.value = overrideMode
    engine.setControlMode(overrideMode)
  }
  cameraError.value = null
  showGuide.value = false
  engine.audio.unlock()

  stopCameraTracking()

  if (selectedMode.value === 'camera') {
    startingCamera.value = true
    try {
      await poseTracker.start(videoRef.value!, 1)
    } catch (err: unknown) {
      stopCameraTracking()
      startingCamera.value = false
      cameraError.value = err instanceof Error ? err.message : String(err)
      return
    }
    startingCamera.value = false
  }

  await engine.startGame(selectedMode.value, selectedWave.value, selectedTheme.value)
}

function handleExitToMenu() {
  stopCameraTracking()
  pressedKeys.clear()
  engine?.setManualLean(0)
  engine?.setManualGuard(false)
  engine?.stopToMenu()
}

function handleGoHome() {
  stopCameraTracking()
  engine?.stopToMenu()
  void router.push('/')
}

function toggleMute() {
  muted.value = !muted.value
  engine?.setMuted(muted.value)
}

function handleRecenter() {
  engine?.recenter()
}

// ---- 键盘控制 ----
function updateManualLeanFromKeys() {
  const left = pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft')
  const right = pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')
  const dir: -1 | 0 | 1 = left && !right ? -1 : right && !left ? 1 : 0
  engine?.setManualLean(dir)
}

function onKeyDown(e: KeyboardEvent) {
  if (!engine || hud.phase !== 'fighting') return
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'].includes(e.code)) {
    e.preventDefault()
  }
  pressedKeys.add(e.code)
  updateManualLeanFromKeys()

  if (
    e.code === 'KeyS' ||
    e.code === 'ArrowDown' ||
    e.code === 'ShiftLeft' ||
    e.code === 'ShiftRight'
  ) {
    engine.setManualGuard(true)
    return
  }
  if (e.repeat) return

  if (e.code === 'KeyJ' || e.code === 'KeyZ') {
    engine.triggerManualPunch('left')
  } else if (e.code === 'KeyK' || e.code === 'KeyX') {
    engine.triggerManualPunch('right')
  } else if (e.code === 'KeyI') {
    engine.triggerManualKick('right')
  } else if (e.code === 'KeyU' || e.code === 'KeyC') {
    engine.triggerManualDisc('right')
  } else if (e.code === 'Space' || e.code === 'KeyL') {
    engine.triggerManualBeam()
  } else if (e.code === 'KeyT') {
    engine.triggerManualTypeSwitch()
  }
}

function onKeyUp(e: KeyboardEvent) {
  pressedKeys.delete(e.code)
  updateManualLeanFromKeys()
  if (
    !pressedKeys.has('KeyS') &&
    !pressedKeys.has('ArrowDown') &&
    !pressedKeys.has('ShiftLeft') &&
    !pressedKeys.has('ShiftRight')
  ) {
    engine?.setManualGuard(false)
  }
}

function onWindowBlur() {
  pressedKeys.clear()
  engine?.setManualLean(0)
  engine?.setManualGuard(false)
}

function onVisibilityChange() {
  if (!document.hidden && engine) {
    engine.resetTracking()
  }
}

// ---- 触屏 / 指针零延迟按钮事件 ----
function onTouchLean(dir: -1 | 0 | 1) {
  engine?.setManualLean(dir)
}
function onTouchGuard(active: boolean) {
  engine?.setManualGuard(active)
}
function onTouchPunch(side: 'left' | 'right') {
  engine?.triggerManualPunch(side)
}
function onTouchKick() {
  engine?.triggerManualKick('right')
}
function onTouchDisc() {
  engine?.triggerManualDisc('right')
}
function onTouchBeam() {
  engine?.triggerManualBeam()
}
function onTouchTypeSwitch() {
  engine?.triggerManualTypeSwitch()
}

onMounted(() => {
  if (!stageRef.value) return

  engine = new UltramanGameEngine(stageRef.value, {
    onHudUpdate: (next) => {
      Object.assign(hud, next)
    },
    onFloatingText: (evt) => {
      floatingEvents.value.push(evt)
      const timer = window.setTimeout(() => {
        floatingEvents.value = floatingEvents.value.filter((item) => item.id !== evt.id)
        floatTimers.delete(evt.id)
      }, 920)
      floatTimers.set(evt.id, timer)
    },
  })

  void engine.preloadBaseAssets()

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  for (const timer of floatTimers.values()) {
    window.clearTimeout(timer)
  }
  floatTimers.clear()
  stopCameraTracking()
  engine?.dispose()
  engine = null
})
</script>

<template>
  <div class="ultra-cockpit" :style="{ '--hero-accent': activeHeroHex }">
    <!-- 3D 实景特摄战场全屏画布 -->
    <div ref="stageRef" class="stage-canvas-wrap" />

    <!-- 伤害与特技飘字层 -->
    <div class="floating-layer" aria-hidden="true">
      <div
        v-for="evt in floatingEvents"
        :key="evt.id"
        class="floating-text"
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
      </div>
    </div>

    <!-- 右下角防卫队战术动捕骨骼雷达窗（体感模式下激活） -->
    <div
      class="tactical-radar"
      :class="{
        visible: isPlaying && selectedMode === 'camera',
        expanded: radarExpanded,
      }"
    >
      <div class="radar-header">
        <span class="radar-badge" :class="hud.bodyCoverage">
          {{
            hud.bodyCoverage === 'full'
              ? t('message.ultramanView.bodySyncFull')
              : hud.bodyCoverage === 'upper'
                ? t('message.ultramanView.bodySyncUpper')
                : t('message.ultramanView.bodySyncNone')
          }}
        </span>
        <button
          type="button"
          class="radar-zoom-btn"
          @click="radarExpanded = !radarExpanded"
        >
          {{ radarExpanded ? '−' : '+' }}
        </button>
      </div>
      <div class="radar-viewport">
        <video ref="videoRef" autoplay playsinline muted class="radar-video" />
        <canvas ref="poseCanvasRef" width="320" height="240" class="radar-skeleton" />
      </div>
      <div class="radar-footer" :class="{ tracked: hud.tracking }">
        <span class="radar-dot" />
        <span class="radar-hint">{{ t(`message.ultramanView.hints.${hud.poseHintKey}`) }}</span>
      </div>
      <div v-if="hud.chargeKind && hud.chargeProgress > 0.05" class="radar-charge-track">
        <div
          class="radar-charge-fill"
          :class="hud.chargeKind"
          :style="{ width: Math.round(hud.chargeProgress * 100) + '%' }"
        />
      </div>
    </div>

    <!-- ================= 机库整备主界面（舞台优先 · 零中央遮挡） ================= -->
    <div v-if="hud.phase === 'menu'" class="hangar-shell">
      <!-- 顶部防卫队战术导航条 -->
      <header class="hangar-topbar">
        <div class="topbar-left">
          <button type="button" class="tac-btn" @click="handleGoHome">
            ‹ {{ t('message.ultramanView.back') }}
          </button>
          <div class="title-cluster">
            <span class="tpc-tag">GUTS // ULTRA MOTION SYSTEM</span>
            <h1 class="hangar-title">{{ t('message.ultramanView.title') }}</h1>
          </div>
        </div>
        <div class="topbar-right">
          <button type="button" class="tac-btn accent" @click="router.push('/ultraman/split')">
            ⚔ {{ t('message.ultramanView.split') }}
          </button>
          <UltraSoundtrack inline :playing="false" :muted="muted" />
          <button type="button" class="tac-btn" @click="toggleMute">
            {{ muted ? t('message.ultramanView.mute') : t('message.ultramanView.unmute') }}
          </button>
        </div>
      </header>

      <!-- 左右双翼非对称控制台，正中央留给 3D 英雄正面仰拍特写 -->
      <div class="hangar-body">
        <!-- 左翼：光之战士机库列 -->
        <aside class="hangar-wing left-wing">
          <div class="wing-header">
            <span class="wing-index">01</span>
            <span>{{ t('message.ultramanView.selectHero') }}</span>
          </div>
          <div class="hero-roster">
            <button
              v-for="id in HERO_IDS"
              :key="id"
              type="button"
              class="hero-card"
              :class="[id, { active: selectedHero === id }]"
              @click="selectHero(id)"
            >
              <div class="hero-card-bar" />
              <div class="hero-card-main">
                <div class="hero-name-row">
                  <span class="hero-cn">{{ t(`message.ultramanView.heroNames.${id}`) }}</span>
                  <span class="hero-code">{{ id.toUpperCase() }}</span>
                </div>
                <div class="hero-role">{{ t(`message.ultramanView.heroRoles.${id}`) }}</div>
              </div>
            </button>
          </div>
        </aside>

        <!-- 中央底部：英雄形态实时切换预览铭牌（不挡躯干与头部） -->
        <div class="stage-pedestal-hud">
          <div class="pedestal-plate">
            <span class="pedestal-code">{{ selectedHero.toUpperCase() }}</span>
            <strong class="pedestal-name">{{ t(`message.ultramanView.heroNames.${selectedHero}`) }}</strong>
            <span
              v-if="hud.hasForms"
              class="form-pill"
              :class="hud.heroForm"
            >
              {{ t(`message.ultramanView.forms.${hud.heroForm}`) }}
            </span>
            <button
              v-if="hud.hasForms"
              type="button"
              class="form-preview-btn"
              @click="handlePreviewForm"
            >
              ↻ {{ t('message.ultramanView.switchFormPreview') }}
            </button>
          </div>
          <p class="pedestal-sub">{{ t('message.ultramanView.subtitle') }}</p>
        </div>

        <!-- 右翼：作战出击指令台 -->
        <aside class="hangar-wing right-wing">
          <!-- 控制模式 -->
          <div class="deck-block">
            <div class="mode-tabs">
              <button
                type="button"
                class="mode-tab"
                :class="{ active: selectedMode === 'camera' }"
                @click="selectControlMode('camera')"
              >
                {{ t('message.ultramanView.cameraMode') }}
              </button>
              <button
                type="button"
                class="mode-tab"
                :class="{ active: selectedMode === 'keyboard' }"
                @click="selectControlMode('keyboard')"
              >
                {{ t('message.ultramanView.keyboardMode') }}
              </button>
            </div>
          </div>

          <!-- 讨伐怪兽波次（点选即时切换远景 3D 怪兽） -->
          <div class="deck-block">
            <div class="wing-header">
              <span class="wing-index">02</span>
              <span>{{ t('message.ultramanView.selectStage') }}</span>
            </div>
            <div class="kaiju-list">
              <button
                v-for="(m, idx) in MONSTER_WAVES"
                :key="m.id"
                type="button"
                class="kaiju-chip"
                :class="{ active: selectedWave === idx }"
                @click="selectWave(idx)"
              >
                <span class="kaiju-idx">0{{ idx + 1 }}</span>
                <span class="kaiju-title">{{ t(`message.ultramanView.monsters.${m.id}`) }}</span>
                <span class="kaiju-hp">{{ m.maxHp }} HP</span>
              </button>
            </div>
          </div>

          <!-- 战场选择 -->
          <div class="deck-block">
            <div class="wing-header">
              <span class="wing-index">03</span>
              <span>{{ t('message.ultramanView.selectArena') }}</span>
            </div>
            <div class="arena-grid">
              <button
                v-for="theme in SCENE_THEMES"
                :key="theme"
                type="button"
                class="arena-pill"
                :class="{ active: selectedTheme === theme }"
                @click="selectSceneTheme(theme)"
              >
                {{ t(`message.ultramanView.arenas.${theme}`) }}
              </button>
            </div>
          </div>

          <!-- 招式图鉴开关 -->
          <div class="deck-block">
            <button
              type="button"
              class="guide-toggle-btn"
              :class="{ open: showGuide }"
              @click="showGuide = !showGuide"
            >
              <span>◈ {{ t('message.ultramanView.guideToggle') }}</span>
              <span>{{ showGuide ? '▲' : '▼' }}</span>
            </button>
          </div>

          <!-- 摄像头权限异常提示 -->
          <div v-if="cameraError" class="camera-alert">
            <div class="camera-alert-text">
              {{ t('message.ultramanView.cameraError') }} {{ cameraError }}
            </div>
            <button
              type="button"
              class="tac-btn warn"
              @click="handleStartBattle('keyboard')"
            >
              {{ t('message.ultramanView.switchToKeyboard') }}
            </button>
          </div>

          <!-- 光之变身出击主按钮 -->
          <button
            type="button"
            class="sortie-cta"
            :disabled="startingCamera"
            @click="handleStartBattle()"
          >
            <span class="sortie-cta-glow" />
            <span class="sortie-cta-label">
              {{
                startingCamera
                  ? t('message.ultramanView.loadingModel')
                  : t('message.ultramanView.startButton')
              }}
            </span>
          </button>
        </aside>
      </div>

      <!-- 可展开招式速查抽屉（根据当前所选控制模式精准呈现体感手势或键位） -->
      <div v-if="showGuide" class="moves-drawer">
        <div class="moves-drawer-grid">
          <div
            v-for="item in moveGuideItems"
            :key="item.key"
            class="guide-card"
            :class="{ ultimate: item.isUltimate }"
          >
            <div class="guide-name">{{ item.name }}</div>
            <div class="guide-desc">{{ item.desc }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 加载过渡遮罩 ================= -->
    <div v-if="hud.phase === 'loading'" class="loading-overlay">
      <div class="loading-box">
        <div class="loading-title">{{ t('message.ultramanView.loadingModel') }}</div>
        <div class="loading-bar-bg">
          <div class="loading-bar-fg" :style="{ width: hud.loadingProgress + '%' }" />
        </div>
        <div class="loading-num">{{ hud.loadingProgress }}%</div>
      </div>
    </div>

    <!-- ================= 实战特摄街机 HUD ================= -->
    <div v-if="isPlaying" class="battle-hud">
      <!-- 顶部三栏战术条 -->
      <div class="hud-top">
        <div class="hud-top-left">
          <div class="score-plate">
            <span class="plate-label">{{ t('message.ultramanView.score') }}</span>
            <span class="plate-value">{{ hud.score }}</span>
          </div>
          <div v-if="hud.combo >= 2" :key="hud.combo" class="combo-badge">
            <span class="combo-num">{{ hud.combo }}</span>
            <span class="combo-txt">{{ t('message.ultramanView.combo') }}</span>
          </div>
        </div>

        <!-- 中央街机斜切怪兽装甲血条（带受击残影延迟滑落条） -->
        <div class="boss-armor-panel">
          <div class="boss-meta-row">
            <span class="boss-wave-tag">
              {{ t('message.ultramanView.wave', { current: hud.waveIndex + 1, total: hud.totalWaves }) }}
            </span>
            <strong class="boss-title">{{ currentMonsterName }}</strong>
            <span
              v-if="
                hud.phase === 'fighting' &&
                ['guarding', 'staggered', 'roaring', 'recovering'].includes(hud.monsterState)
              "
              class="boss-state-chip"
              :class="hud.monsterState"
            >
              {{ t(`message.ultramanView.reactions.${hud.monsterState}`) }}
            </span>
            <span class="boss-hp-digits">{{ hud.monsterHp }} / {{ hud.monsterMaxHp }}</span>
          </div>
          <div class="armor-bar-shell boss">
            <div class="armor-bar-trail" :style="{ width: monsterHpPercent + '%' }" />
            <div class="armor-bar-fill boss" :style="{ width: monsterHpPercent + '%' }" />
          </div>
        </div>

        <!-- 右上紧凑工具栏（收编配乐、场景切换、校准与唯一撤退入口） -->
        <div class="hud-top-right">
          <button type="button" class="tac-btn" @click="cycleActiveArena">
            {{ t(`message.ultramanView.arenas.${hud.activeTheme}`) }}
          </button>
          <UltraSoundtrack inline :playing="isPlaying" :muted="muted" />
          <button type="button" class="tac-btn" @click="toggleMute">
            {{ muted ? t('message.ultramanView.mute') : t('message.ultramanView.unmute') }}
          </button>
          <button
            v-if="selectedMode === 'camera'"
            type="button"
            class="tac-btn"
            @click="handleRecenter"
          >
            {{ t('message.ultramanView.recenter') }}
          </button>
          <button
            v-if="selectedMode === 'camera'"
            type="button"
            class="tac-btn"
            :class="{ active: showSkeleton }"
            @click="showSkeleton = !showSkeleton"
          >
            {{ t('message.ultramanView.skeleton') }}
          </button>
          <button type="button" class="tac-btn danger" @click="handleExitToMenu">
            {{ t('message.ultramanView.stop') }}
          </button>
        </div>
      </div>

      <!-- 宿命双光线对波拔河仪 -->
      <div v-if="hud.beamClashActive" class="clash-hud">
        <div class="clash-prompt">
          {{
            selectedMode === 'keyboard'
              ? t('message.ultramanView.clashPromptKey')
              : t('message.ultramanView.clashPromptCam')
          }}
        </div>
        <div class="clash-tug-track">
          <div
            class="clash-hero-side"
            :style="{ width: Math.round(hud.beamClashProgress * 100) + '%' }"
          />
          <div
            class="clash-spark-knot"
            :style="{ left: Math.round(hud.beamClashProgress * 100) + '%' }"
          />
        </div>
      </div>

      <!-- 模式感知危机预警横幅 -->
      <div v-else-if="hud.warningTextKey" class="hazard-banner">
        <div class="hazard-text">{{ warningMessage }}</div>
        <div class="hazard-progress-bg">
          <div
            class="hazard-progress-fg"
            :style="{ width: Math.round(hud.warningUrgency * 100) + '%' }"
          />
        </div>
      </div>

      <!-- 特摄大字招式播报 -->
      <div
        v-if="hud.activeSkillBannerKey"
        :key="hud.activeSkillBannerKey"
        class="cutin-banner"
        :class="{ shifted: !!hud.warningTextKey || hud.beamClashActive }"
      >
        {{ t(`message.ultramanView.banners.${hud.activeSkillBannerKey}`) }}
      </div>

      <!-- 底部区域：左下彩色计时器装甲舱 + 右侧街机操控台（键盘/触屏模式） -->
      <div class="hud-bottom">
        <div class="hero-cockpit-panel">
          <div class="color-timer" :class="[hud.heroId, { danger: hud.timerDanger }]">
            <div class="color-timer-ring" />
            <div class="color-timer-core" />
          </div>
          <div class="hero-meters">
            <div class="meter-head">
              <span class="meter-title">
                {{ heroHpLabel }}
                <button
                  v-if="hud.hasForms"
                  type="button"
                  class="form-pill interactive"
                  :class="hud.heroForm"
                  @click="onTouchTypeSwitch"
                >
                  {{ t(`message.ultramanView.forms.${hud.heroForm}`) }}
                </button>
              </span>
              <span class="meter-val">{{ hud.heroHp }} / {{ hud.heroMaxHp }}</span>
            </div>
            <div class="armor-bar-shell hero">
              <div class="armor-bar-trail" :style="{ width: heroHpPercent + '%' }" />
              <div
                class="armor-bar-fill hero"
                :class="{ danger: hud.timerDanger }"
                :style="{ width: heroHpPercent + '%' }"
              />
            </div>

            <div v-if="hud.punchChain > 0" class="chain-pips">
              <span class="chain-label">{{ t('message.ultramanView.chainCue') }}</span>
              <i v-for="n in 3" :key="n" :class="{ lit: n <= hud.punchChain }" />
            </div>

            <div class="meter-head energy-head">
              <span class="meter-title">{{ t('message.ultramanView.energy') }}</span>
              <span
                class="energy-status"
                :class="{ full: hud.energy >= 100, ready: hud.energy >= 35 }"
              >
                {{ energyStatusText }}
              </span>
            </div>
            <div class="energy-bar-shell">
              <div class="energy-threshold-tick" style="left: 35%" />
              <div
                class="energy-bar-fill"
                :class="{ full: hud.energy >= 100, ready: hud.energy >= 35 }"
                :style="{ width: hud.energy + '%' }"
              />
            </div>
          </div>
        </div>

        <!-- 键盘 / 触屏双组人体工学街机按键甲板 -->
        <div v-if="selectedMode === 'keyboard'" class="arcade-deck">
          <div class="deck-group movement-pad">
            <button
              type="button"
              class="deck-btn"
              @pointerdown.prevent="onTouchLean(-1)"
              @pointerup="onTouchLean(0)"
              @pointerleave="onTouchLean(0)"
              @pointercancel="onTouchLean(0)"
            >
              <kbd>A</kbd>
              <span>◀ {{ t('message.ultramanView.controls.left') }}</span>
            </button>
            <button
              type="button"
              class="deck-btn guard"
              @pointerdown.prevent="onTouchGuard(true)"
              @pointerup="onTouchGuard(false)"
              @pointerleave="onTouchGuard(false)"
              @pointercancel="onTouchGuard(false)"
            >
              <kbd>S</kbd>
              <span>⛨ {{ t('message.ultramanView.controls.guard') }}</span>
            </button>
            <button
              type="button"
              class="deck-btn"
              @pointerdown.prevent="onTouchLean(1)"
              @pointerup="onTouchLean(0)"
              @pointerleave="onTouchLean(0)"
              @pointercancel="onTouchLean(0)"
            >
              <kbd>D</kbd>
              <span>{{ t('message.ultramanView.controls.right') }} ▶</span>
            </button>
          </div>

          <div class="deck-group strike-pad">
            <div class="strike-row upper">
              <button type="button" class="deck-btn kick" @pointerdown.prevent="onTouchKick">
                <kbd>I</kbd>
                <span>{{ t('message.ultramanView.controls.kick') }}</span>
              </button>
              <button
                type="button"
                class="deck-btn disc"
                :disabled="hud.discCooldownRatio > 0.02"
                @pointerdown.prevent="onTouchDisc"
              >
                <div
                  v-if="hud.discCooldownRatio > 0.02"
                  class="cd-veil"
                  :style="{ height: Math.round(hud.discCooldownRatio * 100) + '%' }"
                />
                <kbd>U</kbd>
                <span>{{ t('message.ultramanView.controls.disc') }}</span>
              </button>
              <button
                v-if="hud.hasForms"
                type="button"
                class="deck-btn form"
                :class="hud.heroForm"
                @pointerdown.prevent="onTouchTypeSwitch"
              >
                <kbd>T</kbd>
                <span>{{ t('message.ultramanView.controls.form') }}</span>
              </button>
            </div>
            <div class="strike-row lower">
              <button
                type="button"
                class="deck-btn punch"
                @pointerdown.prevent="onTouchPunch('left')"
              >
                <kbd>J</kbd>
                <span>{{ t('message.ultramanView.controls.punchL') }}</span>
              </button>
              <button
                type="button"
                class="deck-btn punch"
                @pointerdown.prevent="onTouchPunch('right')"
              >
                <kbd>K</kbd>
                <span>{{ t('message.ultramanView.controls.punchR') }}</span>
              </button>
              <button
                type="button"
                class="deck-btn beam"
                :class="{ ready: hud.energy >= 35, full: hud.energy >= 100 }"
                @pointerdown.prevent="onTouchBeam"
              >
                <div
                  v-if="hud.beamCooldownRatio > 0.02"
                  class="cd-veil"
                  :style="{ height: Math.round(hud.beamCooldownRatio * 100) + '%' }"
                />
                <kbd>SPACE</kbd>
                <span>⚡ {{ t('message.ultramanView.controls.beam') }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 战果结算装甲面板 ================= -->
    <div v-if="hud.phase === 'victory' || hud.phase === 'defeat'" class="result-overlay">
      <div class="result-panel" :class="hud.phase">
        <div class="result-kicker">GUTS BATTLE REPORT // {{ hud.heroId.toUpperCase() }}</div>
        <h2 class="result-heading">
          {{
            hud.phase === 'victory'
              ? t('message.ultramanView.result.victoryTitle')
              : t('message.ultramanView.result.defeatTitle')
          }}
        </h2>

        <div class="result-metrics">
          <div class="metric-tile">
            <span class="metric-label">{{ t('message.ultramanView.result.totalScore') }}</span>
            <strong class="metric-val gold">{{ hud.score }}</strong>
          </div>
          <div class="metric-tile">
            <span class="metric-label">{{ t('message.ultramanView.result.defeated') }}</span>
            <strong class="metric-val">{{ hud.defeatedCount }} / {{ hud.totalWaves }}</strong>
          </div>
          <div class="metric-tile">
            <span class="metric-label">{{ t('message.ultramanView.result.maxCombo') }}</span>
            <strong class="metric-val">{{ hud.maxCombo }}</strong>
          </div>
          <div class="metric-tile">
            <span class="metric-label">{{ t('message.ultramanView.result.perfectGuards') }}</span>
            <strong class="metric-val cyan">{{ hud.perfectGuards }}</strong>
          </div>
        </div>

        <div class="result-btns">
          <button type="button" class="sortie-cta compact" @click="handleStartBattle()">
            <span class="sortie-cta-label">{{ t('message.ultramanView.result.playAgain') }}</span>
          </button>
          <button type="button" class="tac-btn large" @click="handleExitToMenu">
            {{ t('message.ultramanView.result.backMenu') }}
          </button>
          <button type="button" class="tac-btn large" @click="handleGoHome">
            {{ t('message.ultramanView.result.backHome') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ultra-cockpit {
  --hero-accent: #38e8ff;
  position: fixed;
  inset: 0;
  z-index: 1500;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #07111f;
  color: #f1f7ff;
  user-select: none;
  font-family: 'Bahnschrift', 'DIN Alternate', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  font-variant-numeric: tabular-nums;
}

.stage-canvas-wrap {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

/* ---- 飘字层 ---- */
.floating-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 26;
  overflow: hidden;
}

.floating-text {
  position: absolute;
  font-size: 28px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 1px;
  text-shadow:
    0 3px 0 #020617,
    0 0 16px rgba(2, 6, 23, 0.9);
  animation: floatArc 0.92s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  white-space: nowrap;
}

.floating-text.crit,
.floating-text.guard {
  font-size: 33px;
  letter-spacing: 1.5px;
}

@keyframes floatArc {
  0% {
    opacity: 0;
    transform: translate(-50%, -20%) scale(calc(var(--fscale, 1) * 0.65));
  }
  16% {
    opacity: 1;
    transform: translate(calc(-50% + var(--drift-x, 0px) * 0.35), -65%)
      scale(calc(var(--fscale, 1) * 1.18));
  }
  100% {
    opacity: 0;
    transform: translate(calc(-50% + var(--drift-x, 0px)), -175%) scale(var(--fscale, 1));
  }
}

/* ---- 通用防卫队斜切战术按钮 ---- */
.tac-btn {
  padding: 7px 14px;
  background: rgba(9, 19, 34, 0.86);
  border: 1px solid rgba(148, 163, 184, 0.42);
  clip-path: polygon(7px 0, 100% 0, calc(100% - 7px) 100%, 0 100%);
  color: #e2f1ff;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tac-btn:hover {
  background: rgba(18, 38, 64, 0.95);
  border-color: var(--hero-accent);
  color: #ffffff;
}

.tac-btn.active,
.tac-btn.accent {
  border-color: #38e8ff;
  background: rgba(14, 65, 98, 0.85);
  color: #7dd3fc;
}

.tac-btn.danger {
  border-color: rgba(248, 113, 113, 0.72);
  background: rgba(127, 29, 29, 0.84);
  color: #fecaca;
}

.tac-btn.danger:hover {
  background: rgba(185, 28, 28, 0.95);
}

.tac-btn.warn {
  background: #facc15;
  border-color: #fef08a;
  color: #091325;
}

.tac-btn.large {
  padding: 12px 24px;
  font-size: 14px;
}

/* ================= 机库整备主菜单（舞台优先非对称布局） ================= */
.hangar-shell {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 16px 22px 20px;
  pointer-events: none;
  /* 仅两侧边缘压暗衬托文字，正中央 100% 通透呈现 3D 奥特曼与远景怪兽 */
  background:
    linear-gradient(
      90deg,
      rgba(5, 11, 22, 0.84) 0%,
      rgba(5, 11, 22, 0.22) 28%,
      rgba(5, 11, 22, 0) 50%,
      rgba(5, 11, 22, 0.28) 70%,
      rgba(5, 11, 22, 0.88) 100%
    ),
    linear-gradient(180deg, rgba(5, 11, 22, 0.65) 0%, transparent 18%, transparent 82%, rgba(5, 11, 22, 0.72) 100%);
}

.hangar-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  pointer-events: auto;
}

.topbar-left,
.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.title-cluster {
  display: flex;
  flex-direction: column;
  margin-left: 4px;
}

.tpc-tag {
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 2.2px;
  color: var(--hero-accent);
}

.hangar-title {
  margin: 0;
  font-size: clamp(20px, 2.4vw, 30px);
  font-weight: 900;
  font-style: italic;
  letter-spacing: 1.5px;
  color: #ffffff;
  text-shadow: 0 2px 14px rgba(56, 232, 255, 0.45);
}

.hangar-body {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(230px, 285px) 1fr minmax(270px, 340px);
  align-items: center;
  gap: 16px;
  min-height: 0;
}

.hangar-wing {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  padding: 14px 16px;
  background: rgba(8, 17, 32, 0.78);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(56, 232, 255, 0.32);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
}

.left-wing {
  clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%);
}

.right-wing {
  clip-path: polygon(14px 0, 100% 0, 100% 100%, 0 100%, 0 14px);
}

.wing-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 6px;
}

.wing-index {
  padding: 1px 6px;
  background: rgba(56, 232, 255, 0.16);
  border-left: 2px solid var(--hero-accent);
  color: var(--hero-accent);
}

/* 左翼英雄卡片 */
.hero-roster {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.hero-card {
  position: relative;
  display: flex;
  align-items: stretch;
  padding: 11px 13px;
  background: rgba(15, 28, 48, 0.76);
  border: 1px solid rgba(148, 163, 184, 0.25);
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
  color: #e2e8f0;
  text-align: left;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, background 0.16s ease;
}

.hero-card:hover {
  transform: translateX(4px);
  border-color: rgba(125, 211, 252, 0.65);
}

.hero-card-bar {
  width: 4px;
  margin-right: 11px;
  background: #475569;
  transition: background 0.16s, box-shadow 0.16s;
}

.hero-card.tiga.active {
  border-color: #38e8ff;
  background: linear-gradient(90deg, rgba(56, 232, 255, 0.2), rgba(15, 28, 48, 0.85));
}
.hero-card.tiga.active .hero-card-bar {
  background: #38e8ff;
  box-shadow: 0 0 10px #38e8ff;
}

.hero-card.zero.active {
  border-color: #5eead4;
  background: linear-gradient(90deg, rgba(94, 234, 212, 0.2), rgba(15, 28, 48, 0.85));
}
.hero-card.zero.active .hero-card-bar {
  background: #5eead4;
  box-shadow: 0 0 10px #5eead4;
}

.hero-card.dyna.active {
  border-color: #ffbd49;
  background: linear-gradient(90deg, rgba(255, 189, 73, 0.22), rgba(15, 28, 48, 0.85));
}
.hero-card.dyna.active .hero-card-bar {
  background: #ffbd49;
  box-shadow: 0 0 10px #ffbd49;
}

.hero-card.zeta.active {
  border-color: #60a5fa;
  background: linear-gradient(90deg, rgba(96, 165, 250, 0.22), rgba(15, 28, 48, 0.85));
}
.hero-card.zeta.active .hero-card-bar {
  background: #60a5fa;
  box-shadow: 0 0 10px #60a5fa;
}

.hero-card-main {
  flex: 1;
  min-width: 0;
}

.hero-name-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.hero-cn {
  font-size: 16px;
  font-weight: 900;
  color: #ffffff;
}

.hero-code {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1.5px;
  color: #7dd3fc;
}

.hero-role {
  margin-top: 3px;
  font-size: 11px;
  color: #94a3b8;
}

/* 中央底部舞台底座铭牌（绝不挡住英雄身体） */
.stage-pedestal-hud {
  align-self: end;
  justify-self: center;
  text-align: center;
  padding-bottom: 6px;
  pointer-events: auto;
}

.pedestal-plate {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 7px 18px;
  background: rgba(7, 16, 30, 0.82);
  border: 1px solid rgba(56, 232, 255, 0.45);
  clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.5);
}

.pedestal-code {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 2px;
  color: var(--hero-accent);
}

.pedestal-name {
  font-size: 17px;
  font-weight: 900;
  color: #ffffff;
}

.form-preview-btn {
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid rgba(250, 204, 21, 0.65);
  background: rgba(250, 204, 21, 0.14);
  color: #fef08a;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
  transition: background 0.15s;
}

.form-preview-btn:hover {
  background: rgba(250, 204, 21, 0.28);
}

.pedestal-sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: rgba(226, 232, 240, 0.85);
  text-shadow: 0 2px 6px #000;
}

/* 形态徽章 */
.form-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.5px;
  background: rgba(56, 232, 255, 0.18);
  border: 1px solid rgba(56, 232, 255, 0.65);
  color: #7dd3fc;
}

.form-pill.interactive {
  margin-left: 6px;
  cursor: pointer;
}

.form-pill.power,
.form-pill.strong {
  background: rgba(239, 68, 68, 0.24);
  border-color: #fb7185;
  color: #fecdd3;
}

.form-pill.sky {
  background: rgba(168, 85, 247, 0.24);
  border-color: #c084fc;
  color: #e9d5ff;
}

.form-pill.miracle {
  background: rgba(14, 165, 233, 0.25);
  border-color: #38bdf8;
  color: #bae6fd;
}

/* 右翼指令舱 */
.deck-block {
  display: flex;
  flex-direction: column;
}

.mode-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  padding: 4px;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.25);
}

.mode-tab {
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: #94a3b8;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-tab.active {
  background: linear-gradient(90deg, #38e8ff, #60a5fa);
  color: #06101e;
  box-shadow: 0 0 14px rgba(56, 232, 255, 0.35);
}

.kaiju-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kaiju-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 11px;
  background: rgba(15, 28, 48, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.22);
  color: #cbd5e1;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: all 0.14s;
}

.kaiju-chip:hover {
  border-color: rgba(250, 204, 21, 0.55);
}

.kaiju-chip.active {
  border-color: #facc15;
  background: linear-gradient(90deg, rgba(250, 204, 21, 0.2), rgba(15, 28, 48, 0.85));
  color: #fef08a;
}

.kaiju-idx {
  font-size: 11px;
  font-weight: 900;
  color: #38e8ff;
}

.kaiju-title {
  flex: 1;
  text-align: left;
}

.kaiju-hp {
  font-size: 10px;
  color: #94a3b8;
}

.arena-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.arena-pill {
  padding: 5px 10px;
  background: rgba(15, 28, 48, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.28);
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
  transition: all 0.14s;
}

.arena-pill.active {
  border-color: #38e8ff;
  background: rgba(56, 232, 255, 0.18);
  color: #bae6fd;
}

.guide-toggle-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  background: rgba(15, 28, 48, 0.75);
  border: 1px dashed rgba(125, 211, 252, 0.42);
  color: #bae6fd;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}

.camera-alert {
  padding: 10px 12px;
  background: rgba(153, 27, 27, 0.42);
  border: 1px solid rgba(248, 113, 113, 0.75);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.camera-alert-text {
  font-size: 12px;
  color: #fecaca;
}

.sortie-cta {
  position: relative;
  overflow: hidden;
  padding: 14px 24px;
  border: none;
  clip-path: polygon(12px 0, 100% 0, calc(100% - 12px) 100%, 0 100%);
  background: linear-gradient(95deg, #38e8ff 0%, #facc15 52%, #fb923c 100%);
  color: #050d1a;
  font-size: 17px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 2px;
  cursor: pointer;
  box-shadow: 0 10px 28px rgba(56, 232, 255, 0.38);
  transition: transform 0.14s ease, box-shadow 0.14s ease;
}

.sortie-cta:hover:not(:disabled) {
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 14px 34px rgba(250, 204, 21, 0.55);
}

.sortie-cta:disabled {
  opacity: 0.65;
  cursor: wait;
}

.sortie-cta.compact {
  padding: 12px 30px;
  font-size: 15px;
}

/* 招式速查抽屉 */
.moves-drawer {
  pointer-events: auto;
  margin-top: 8px;
  padding: 12px 16px;
  background: rgba(7, 15, 28, 0.94);
  border: 1px solid rgba(56, 232, 255, 0.45);
  animation: drawerSlide 0.18s ease-out;
}

@keyframes drawerSlide {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.moves-drawer-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(135px, 1fr));
  gap: 8px;
}

.guide-card {
  padding: 8px 10px;
  background: rgba(18, 33, 56, 0.78);
  border-left: 3px solid #38e8ff;
}

.guide-card.ultimate {
  border-left-color: #facc15;
  background: linear-gradient(90deg, rgba(250, 204, 21, 0.16), rgba(18, 33, 56, 0.82));
}

.guide-name {
  font-size: 12px;
  font-weight: 900;
  color: #ffffff;
}

.guide-desc {
  margin-top: 3px;
  font-size: 11px;
  color: #94a3b8;
  line-height: 1.35;
}

/* ================= 战术动捕骨骼雷达窗 ================= */
.tactical-radar {
  position: fixed;
  right: 18px;
  bottom: 18px;
  width: 228px;
  background: rgba(6, 14, 26, 0.9);
  border: 1.5px solid rgba(56, 232, 255, 0.65);
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.6);
  z-index: 36;
  opacity: 0;
  pointer-events: none;
  transform: translateY(12px);
  transition: width 0.22s ease, opacity 0.22s ease, transform 0.22s ease;
}

.tactical-radar.visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.tactical-radar.expanded {
  width: 320px;
}

.radar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: rgba(12, 26, 46, 0.95);
  border-bottom: 1px solid rgba(56, 232, 255, 0.25);
}

.radar-badge {
  font-size: 10px;
  font-weight: 900;
  color: #cbd5e1;
}

.radar-badge.full {
  color: #4ade80;
}

.radar-badge.upper {
  color: #38e8ff;
}

.radar-zoom-btn {
  width: 20px;
  height: 20px;
  border: 1px solid rgba(125, 211, 252, 0.45);
  background: rgba(15, 23, 42, 0.9);
  color: #e2e8f0;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.radar-viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
}

.radar-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.radar-skeleton {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.radar-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  font-size: 11px;
  font-weight: 700;
  color: #cbd5e1;
  background: rgba(8, 17, 32, 0.95);
}

.radar-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f97316;
  flex-shrink: 0;
}

.radar-footer.tracked .radar-dot {
  background: #22c55e;
  box-shadow: 0 0 8px #22c55e;
}

.radar-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.radar-charge-track {
  height: 4px;
  background: rgba(255, 255, 255, 0.14);
}

.radar-charge-fill {
  height: 100%;
  transition: width 0.06s linear;
}
.radar-charge-fill.beam {
  background: linear-gradient(90deg, #38bdf8, #facc15);
}
.radar-charge-fill.disc {
  background: #67e8f9;
}
.radar-charge-fill.guard {
  background: #38bdf8;
}
.radar-charge-fill.type {
  background: linear-gradient(90deg, #a855f7, #f472b6);
}

/* ================= 战斗 HUD ================= */
.battle-hud {
  position: fixed;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  padding: 14px 18px 16px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.hud-top {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(280px, 540px) minmax(180px, 1fr);
  align-items: start;
  gap: 12px;
}

.hud-top-left,
.hud-top-right {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  pointer-events: auto;
}

.hud-top-right {
  justify-content: flex-end;
}

.score-plate {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 14px;
  background: rgba(8, 17, 32, 0.88);
  border-left: 3px solid #facc15;
  border-top: 1px solid rgba(250, 204, 21, 0.35);
  border-bottom: 1px solid rgba(250, 204, 21, 0.35);
  clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
}

.plate-label {
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 1px;
  color: #94a3b8;
}

.plate-value {
  font-size: 19px;
  font-weight: 900;
  color: #fde047;
}

.combo-badge {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 4px 13px;
  background: linear-gradient(95deg, #ea580c, #facc15);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: #050d1a;
  animation: comboSlam 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.combo-num {
  font-size: 18px;
  font-weight: 900;
  font-style: italic;
}

.combo-txt {
  font-size: 11px;
  font-weight: 900;
}

@keyframes comboSlam {
  from {
    transform: scale(1.38);
  }
  to {
    transform: scale(1);
  }
}

/* 顶部中央怪兽斜切装甲血条（带受击金色残影延迟滑落） */
.boss-armor-panel {
  padding: 8px 16px 10px;
  background: rgba(8, 16, 30, 0.86);
  border: 1px solid rgba(248, 113, 113, 0.65);
  clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 10px, calc(100% - 6px) 100%, 6px 100%, 0 10px);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
}

.boss-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.boss-wave-tag {
  padding: 2px 8px;
  background: #dc2626;
  color: #ffffff;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 1px;
}

.boss-title {
  font-size: 16px;
  font-weight: 900;
  letter-spacing: 1px;
  color: #ffffff;
}

.boss-state-chip {
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 900;
  background: rgba(52, 211, 153, 0.18);
  border: 1px solid rgba(52, 211, 153, 0.65);
  color: #6ee7b7;
}

.boss-state-chip.guarding {
  background: rgba(96, 165, 250, 0.2);
  border-color: #60a5fa;
  color: #bfdbfe;
}

.boss-state-chip.roaring {
  background: rgba(251, 146, 60, 0.22);
  border-color: #fb923c;
  color: #fed7aa;
}

.boss-hp-digits {
  font-size: 12px;
  font-weight: 800;
  color: #fca5a5;
}

/* 通用带残影缓冲的装甲血条外壳 */
.armor-bar-shell {
  position: relative;
  height: 13px;
  background: rgba(2, 6, 23, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.22);
  transform: skewX(-14deg);
  overflow: hidden;
}

.armor-bar-shell.hero {
  height: 11px;
}

.armor-bar-trail {
  position: absolute;
  inset: 0 auto 0 0;
  background: #fef08a;
  transition: width 0.65s cubic-bezier(0.22, 1, 0.36, 1) 0.1s;
}

.armor-bar-fill {
  position: relative;
  height: 100%;
  transition: width 0.12s ease-out;
}

.armor-bar-fill.boss {
  background: linear-gradient(90deg, #991b1b 0%, #ef4444 55%, #fb923c 100%);
  box-shadow: 0 0 12px rgba(239, 68, 68, 0.75);
}

.armor-bar-fill.hero {
  background: linear-gradient(90deg, #0284c7, var(--hero-accent));
}

.armor-bar-fill.hero.danger {
  background: linear-gradient(90deg, #dc2626, #f97316);
}

/* 宿命双光线对波拔河条 */
.clash-hud {
  position: fixed;
  top: 88px;
  left: 50%;
  transform: translateX(-50%);
  width: min(520px, 88vw);
  padding: 10px 18px 13px;
  background: rgba(9, 14, 28, 0.92);
  border: 2px solid #facc15;
  box-shadow: 0 0 32px rgba(250, 204, 21, 0.65);
  text-align: center;
}

.clash-prompt {
  font-size: 14px;
  font-weight: 900;
  color: #fef08a;
  margin-bottom: 8px;
  letter-spacing: 0.8px;
}

.clash-tug-track {
  position: relative;
  height: 14px;
  background: linear-gradient(90deg, #9333ea, #ec4899);
  border: 1px solid #ffffff;
  overflow: visible;
}

.clash-hero-side {
  height: 100%;
  background: linear-gradient(90deg, #0284c7, #38e8ff, #fef08a);
  transition: width 0.06s linear;
}

.clash-spark-knot {
  position: absolute;
  top: 50%;
  width: 22px;
  height: 22px;
  transform: translate(-50%, -50%) rotate(45deg);
  background: #ffffff;
  border: 2px solid #facc15;
  box-shadow: 0 0 18px #ffffff, 0 0 28px #facc15;
}

/* 危机预警条 */
.hazard-banner {
  position: fixed;
  top: 86px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 22px 9px;
  min-width: min(420px, 90vw);
  background: rgba(153, 27, 27, 0.9);
  border: 1.5px solid #fde047;
  clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  box-shadow: 0 0 24px rgba(239, 68, 68, 0.75);
  text-align: center;
  animation: hazardPulse 0.42s ease-in-out infinite alternate;
}

@keyframes hazardPulse {
  from {
    transform: translateX(-50%) scale(1);
  }
  to {
    transform: translateX(-50%) scale(1.025);
  }
}

.hazard-text {
  font-size: 13px;
  font-weight: 900;
  color: #ffffff;
  margin-bottom: 5px;
}

.hazard-progress-bg {
  height: 4px;
  background: rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.hazard-progress-fg {
  height: 100%;
  background: #facc15;
}

/* 招式斜切特写横幅 */
.cutin-banner {
  position: fixed;
  top: 90px;
  left: 50%;
  transform: translateX(-50%);
  padding: 7px 28px;
  background: linear-gradient(95deg, rgba(8, 47, 73, 0.94), rgba(30, 64, 175, 0.92));
  border-top: 2px solid #fef08a;
  border-bottom: 2px solid #38e8ff;
  clip-path: polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%);
  font-size: clamp(18px, 2.3vw, 25px);
  font-weight: 900;
  font-style: italic;
  letter-spacing: 2px;
  color: #fef9c3;
  text-shadow: 0 2px 0 #020617;
  box-shadow: 0 8px 26px rgba(56, 232, 255, 0.55);
  animation: cutinSlam 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: nowrap;
}

.cutin-banner.shifted {
  top: 150px;
}

@keyframes cutinSlam {
  from {
    opacity: 0;
    transform: translateX(-50%) skewX(-12deg) scale(0.78);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) skewX(0deg) scale(1);
  }
}

/* 底部区域：左下装甲仪 + 右侧街机甲板 */
.hud-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.hero-cockpit-panel {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 14px;
  width: min(370px, 58vw);
  padding: 12px 16px;
  background: rgba(8, 17, 32, 0.88);
  border: 1.5px solid rgba(56, 232, 255, 0.55);
  clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55);
}

.color-timer {
  position: relative;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle, #7dd3fc 0%, #0284c7 62%, #082f49 100%);
  border: 3px solid #cbd5e1;
  box-shadow: 0 0 18px rgba(56, 232, 255, 0.85);
}

.color-timer-ring {
  position: absolute;
  inset: 4px;
  border-radius: 50%;
  border: 1px dashed rgba(255, 255, 255, 0.55);
}

.color-timer-core {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #e0f7ff;
  box-shadow: 0 0 12px #38e8ff;
}

.color-timer.zero {
  background: radial-gradient(circle, #ccfbf1 0%, #14b8a6 58%, #0f172a 100%);
  box-shadow: 0 0 20px rgba(94, 234, 212, 0.9);
}

.color-timer.dyna {
  background: radial-gradient(circle, #dbeafe 0%, #2563eb 58%, #0f172a 100%);
  border-color: #fde68a;
}

.color-timer.danger {
  background: radial-gradient(circle, #fecaca 0%, #dc2626 62%, #450a0a 100%);
  box-shadow: 0 0 24px rgba(239, 68, 68, 0.95);
  animation: timerDangerBlink 0.5s ease-in-out infinite alternate;
}

.color-timer.danger .color-timer-core {
  background: #fee2e2;
  box-shadow: 0 0 14px #ef4444;
}

@keyframes timerDangerBlink {
  from {
    opacity: 1;
    transform: scale(1.06);
  }
  to {
    opacity: 0.48;
    transform: scale(0.95);
  }
}

.hero-meters {
  flex: 1;
  min-width: 0;
}

.meter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  font-weight: 800;
  margin-bottom: 4px;
}

.energy-head {
  margin-top: 8px;
}

.meter-title {
  color: #cbd5e1;
}

.meter-val {
  color: #7dd3fc;
}

.chain-pips {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
}

.chain-label {
  font-size: 10px;
  font-weight: 900;
  color: #fde047;
}

.chain-pips i {
  width: 16px;
  height: 5px;
  transform: skewX(-18deg);
  background: rgba(148, 163, 184, 0.3);
}

.chain-pips i.lit {
  background: #facc15;
  box-shadow: 0 0 8px #facc15;
}

.energy-status {
  font-size: 11px;
  color: #94a3b8;
}

.energy-status.ready {
  color: #38e8ff;
}

.energy-status.full {
  color: #fde047;
  animation: timerDangerBlink 0.6s infinite alternate;
}

.energy-bar-shell {
  position: relative;
  height: 10px;
  background: rgba(2, 6, 23, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.2);
  transform: skewX(-14deg);
  overflow: hidden;
}

.energy-threshold-tick {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: rgba(255, 255, 255, 0.65);
  z-index: 2;
}

.energy-bar-fill {
  height: 100%;
  background: #475569;
  transition: width 0.14s ease;
}

.energy-bar-fill.ready {
  background: linear-gradient(90deg, #0284c7, #38e8ff);
}

.energy-bar-fill.full {
  background: linear-gradient(90deg, #38e8ff, #facc15, #fb923c);
  box-shadow: 0 0 12px #facc15;
}

/* 双组街机操控台（键盘/触屏模式） */
.arcade-deck {
  pointer-events: auto;
  display: flex;
  align-items: flex-end;
  gap: 12px;
}

.movement-pad {
  display: flex;
  gap: 6px;
}

.strike-pad {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.strike-row {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.deck-btn {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 68px;
  padding: 7px 12px;
  background: rgba(11, 22, 38, 0.9);
  border: 1.5px solid rgba(148, 163, 184, 0.42);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: #f8fafc;
  font-size: 12px;
  font-weight: 900;
  cursor: pointer;
  touch-action: none;
  transition: transform 0.08s ease, border-color 0.14s;
}

.deck-btn:active:not(:disabled) {
  transform: scale(0.94);
}

.deck-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.deck-btn kbd {
  font-family: inherit;
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 0.8px;
  color: #94a3b8;
  margin-bottom: 2px;
}

.cd-veil {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(2, 6, 23, 0.72);
  pointer-events: none;
}

.deck-btn.guard {
  border-color: #38bdf8;
  color: #bae6fd;
}

.deck-btn.punch {
  border-color: #fb923c;
  background: rgba(124, 45, 18, 0.85);
}

.deck-btn.kick {
  border-color: #facc15;
  background: rgba(146, 64, 14, 0.85);
}

.deck-btn.disc {
  border-color: #22d3ee;
  background: rgba(14, 116, 144, 0.82);
}

.deck-btn.form {
  border-color: #c084fc;
  background: rgba(88, 28, 135, 0.85);
}

.deck-btn.beam {
  min-width: 96px;
  border-color: #475569;
  opacity: 0.72;
}

.deck-btn.beam.ready {
  opacity: 1;
  border-color: #38e8ff;
  background: linear-gradient(135deg, #0369a1, #1d4ed8);
}

.deck-btn.beam.full {
  opacity: 1;
  border-color: #fef08a;
  background: linear-gradient(135deg, #d97706, #dc2626);
  box-shadow: 0 0 18px rgba(250, 204, 21, 0.75);
}

/* ================= 结算面板 ================= */
.result-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 10, 22, 0.76);
  backdrop-filter: blur(8px);
}

.result-panel {
  width: min(540px, 92vw);
  padding: 28px 30px;
  background: rgba(8, 18, 34, 0.95);
  border: 2px solid #38e8ff;
  clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7);
  text-align: center;
}

.result-panel.victory {
  border-color: #facc15;
}

.result-kicker {
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #7dd3fc;
  margin-bottom: 6px;
}

.result-heading {
  margin: 0 0 22px;
  font-size: 28px;
  font-weight: 900;
  font-style: italic;
  color: #fef08a;
}

.result-panel.defeat .result-heading {
  color: #fca5a5;
}

.result-metrics {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 24px;
}

.metric-tile {
  padding: 13px;
  background: rgba(18, 33, 56, 0.72);
  border-left: 3px solid rgba(148, 163, 184, 0.45);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.metric-label {
  font-size: 11px;
  color: #94a3b8;
}

.metric-val {
  font-size: 24px;
  font-weight: 900;
}

.metric-val.gold {
  color: #fde047;
}

.metric-val.cyan {
  color: #38e8ff;
}

.result-btns {
  display: flex;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* 窄屏与移动端适配 */
@media (max-width: 960px) {
  .hangar-body {
    grid-template-columns: 1fr;
    align-items: end;
    overflow-y: auto;
    padding-top: 8px;
  }

  .hangar-wing {
    max-height: none;
  }

  .hero-roster {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .hud-top {
    grid-template-columns: 1fr;
  }

  .hud-top-right {
    justify-content: flex-start;
  }

  .hud-bottom {
    flex-direction: column;
    align-items: stretch;
  }

  .hero-cockpit-panel {
    width: 100%;
  }

  .arcade-deck {
    width: 100%;
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .tactical-radar {
    width: 152px;
  }
}
</style>
