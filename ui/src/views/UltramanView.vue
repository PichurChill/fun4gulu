<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { UltramanGameEngine } from '@/games/ultraman/engine'
import { MONSTER_WAVES } from '@/games/ultraman/monsters'
import type {
  BattleHudState,
  ControlMode,
  FloatingDamageEvent,
  PoseLandmark,
} from '@/games/ultraman/types'

interface MediaPipePoseInstance {
  setOptions(opts: Record<string, unknown>): void
  onResults(cb: (res: { poseLandmarks?: PoseLandmark[] }) => void): void
  send(input: { image: HTMLVideoElement }): Promise<void>
  close?: () => Promise<void>
}

interface MediaPipeCameraInstance {
  start(): Promise<void>
  stop(): void
}

const router = useRouter()
const { t } = useI18n()

// ---- DOM 引用 ----
const stageRef = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const poseCanvasRef = ref<HTMLCanvasElement | null>(null)

// ---- 交互与配置状态 ----
const selectedMode = ref<ControlMode>('camera')
const selectedWave = ref(0)
const muted = ref(false)
const showSkeleton = ref(true)
const cameraError = ref<string | null>(null)
const startingCamera = ref(false)
const floatingEvents = ref<FloatingDamageEvent[]>([])

const hud = reactive<BattleHudState>({
  phase: 'menu',
  loadingProgress: 0,
  waveIndex: 0,
  totalWaves: MONSTER_WAVES.length,
  monsterId: MONSTER_WAVES[0]!.id,
  monsterHp: MONSTER_WAVES[0]!.maxHp,
  monsterMaxHp: MONSTER_WAVES[0]!.maxHp,
  heroHp: 100,
  heroMaxHp: 100,
  energy: 50,
  score: 0,
  combo: 0,
  maxCombo: 0,
  perfectGuards: 0,
  defeatedCount: 0,
  warningTextKey: null,
  warningUrgency: 0,
  chargeKind: null,
  chargeProgress: 0,
  activeSkillBannerKey: null,
  tracking: false,
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
const isPlaying = computed(
  () =>
    hud.phase === 'intro' ||
    hud.phase === 'fighting' ||
    hud.phase === 'wave-clear',
)

// ---- 运行时句柄 ----
let engine: UltramanGameEngine | null = null
let poseInstance: MediaPipePoseInstance | null = null
let cameraInstance: MediaPipeCameraInstance | null = null
let poseCtx: CanvasRenderingContext2D | null = null
let mediapipeLoaded = false
const pressedKeys = new Set<string>()
const floatTimers = new Map<number, number>()

// ---- MediaPipe 按需加载 ----
const MEDIAPIPE_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/pose.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@0.3.1675466124/drawing_utils.js',
]

async function ensureMediaPipeScripts(): Promise<void> {
  if (mediapipeLoaded) return
  await Promise.all(
    MEDIAPIPE_SCRIPTS.map(
      (src) =>
        new Promise<void>((resolve, reject) => {
          if (document.querySelector(`script[src="${src}"]`)) {
            resolve()
            return
          }
          const s = document.createElement('script')
          s.src = src
          s.crossOrigin = 'anonymous'
          s.onload = () => resolve()
          s.onerror = () => reject(new Error(`Failed to load ${src}`))
          document.head.appendChild(s)
        }),
    ),
  )
  mediapipeLoaded = true
}

function drawMiniSkeleton(landmarks: PoseLandmark[] | undefined) {
  const canvas = poseCanvasRef.value
  if (!canvas) return
  if (!poseCtx) poseCtx = canvas.getContext('2d')
  if (!poseCtx) return

  poseCtx.clearRect(0, 0, canvas.width, canvas.height)
  if (!landmarks || !showSkeleton.value) return

  const w = canvas.width
  const h = canvas.height
  poseCtx.save()
  // 镜像绘制以匹配镜像视频画面
  poseCtx.translate(w, 0)
  poseCtx.scale(-1, 1)

  const win = window as unknown as {
    drawConnectors?: (
      ctx: CanvasRenderingContext2D,
      lms: PoseLandmark[],
      conns: unknown,
      style: Record<string, unknown>,
    ) => void
    drawLandmarks?: (
      ctx: CanvasRenderingContext2D,
      lms: PoseLandmark[],
      style: Record<string, unknown>,
    ) => void
    POSE_CONNECTIONS?: unknown
  }

  if (win.drawConnectors && win.POSE_CONNECTIONS) {
    win.drawConnectors(poseCtx, landmarks, win.POSE_CONNECTIONS, {
      color: '#38e8ff',
      lineWidth: 2.5,
    })
  }
  if (win.drawLandmarks) {
    win.drawLandmarks(poseCtx, landmarks, {
      color: '#facc15',
      lineWidth: 1,
      radius: 3,
    })
  }
  poseCtx.restore()
}

async function startCameraTracking(): Promise<void> {
  if (!videoRef.value) throw new Error('Video element unavailable')
  await ensureMediaPipeScripts()

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } },
    audio: false,
  })
  videoRef.value.srcObject = stream
  await videoRef.value.play()

  const win = window as unknown as {
    Pose: new (cfg: { locateFile: (file: string) => string }) => MediaPipePoseInstance
    Camera: new (
      video: HTMLVideoElement,
      cfg: { onFrame: () => Promise<void>; width: number; height: number },
    ) => MediaPipeCameraInstance
  }

  poseInstance = new win.Pose({
    locateFile: (file: string) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`,
  })
  poseInstance.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  })
  poseInstance.onResults((results) => {
    const lms = results.poseLandmarks ?? null
    drawMiniSkeleton(lms ?? undefined)
    engine?.feedPoseLandmarks(lms, performance.now(), 480, 360)
  })

  cameraInstance = new win.Camera(videoRef.value, {
    onFrame: async () => {
      if (poseInstance && videoRef.value) {
        await poseInstance.send({ image: videoRef.value })
      }
    },
    width: 480,
    height: 360,
  })
  await cameraInstance.start()
}

function stopCameraTracking() {
  if (cameraInstance) {
    try {
      cameraInstance.stop()
    } catch {
      // 忽略停止过程中的浏览器状态异常
    }
    cameraInstance = null
  }
  if (poseInstance) {
    try {
      void poseInstance.close?.()
    } catch {
      // 忽略关闭异常
    }
    poseInstance = null
  }
  const stream = videoRef.value?.srcObject as MediaStream | null
  if (stream) {
    stream.getTracks().forEach((tr) => tr.stop())
    if (videoRef.value) videoRef.value.srcObject = null
  }
  if (poseCtx && poseCanvasRef.value) {
    poseCtx.clearRect(0, 0, poseCanvasRef.value.width, poseCanvasRef.value.height)
  }
}

// ---- 游戏流程控制 ----
async function handleStartBattle(overrideMode?: ControlMode) {
  if (!engine) return
  if (overrideMode) selectedMode.value = overrideMode
  cameraError.value = null

  stopCameraTracking()

  if (selectedMode.value === 'camera') {
    startingCamera.value = true
    try {
      await startCameraTracking()
    } catch (err: unknown) {
      startingCamera.value = false
      const msg = err instanceof Error ? err.message : String(err)
      cameraError.value = msg
      return
    }
    startingCamera.value = false
  }

  await engine.startGame(selectedMode.value, selectedWave.value)
}

function handleExitToMenu() {
  stopCameraTracking()
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
  engine?.gesture.recenter()
}

// ---- 键盘控制（支持键盘模式，也支持在体感模式下随时辅助测试与陪玩） ----
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

  if (e.code === 'KeyS' || e.code === 'ArrowDown' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    engine.setManualGuard(true)
    return
  }
  if (e.repeat) return

  if (e.code === 'KeyJ' || e.code === 'KeyZ') {
    engine.triggerManualPunch('left')
  } else if (e.code === 'KeyK' || e.code === 'KeyX') {
    engine.triggerManualPunch('right')
  } else if (e.code === 'KeyU' || e.code === 'KeyC') {
    engine.triggerManualDisc('right')
  } else if (e.code === 'Space' || e.code === 'KeyL') {
    engine.triggerManualBeam()
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

function onVisibilityChange() {
  if (!document.hidden && engine) {
    engine.gesture.reset()
  }
}

// ---- 触屏按钮事件 ----
function onTouchLean(dir: -1 | 0 | 1) {
  engine?.setManualLean(dir)
}
function onTouchGuard(active: boolean) {
  engine?.setManualGuard(active)
}
function onTouchPunch(side: 'left' | 'right') {
  engine?.triggerManualPunch(side)
}
function onTouchDisc() {
  engine?.triggerManualDisc('right')
}
function onTouchBeam() {
  engine?.triggerManualBeam()
}

// ---- 生命周期 ----
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
      }, 950)
      floatTimers.set(evt.id, timer)
    },
  })

  // 进入页面立即静默预加载 3D 迪迦背影 + 海港城市 + 第 1 关怪兽作为背景舞台
  void engine.preloadBaseAssets()

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
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
  <div class="ultraman-page">
    <!-- 3D 海港城市战斗舞台（全屏铺底） -->
    <div ref="stageRef" class="stage-canvas-wrap" />

    <!-- 飘字层（伤害数值、完美防御、闪避） -->
    <div class="floating-layer" aria-hidden="true">
      <div
        v-for="evt in floatingEvents"
        :key="evt.id"
        class="floating-text"
        :style="{
          left: evt.x + '%',
          top: evt.y + '%',
          color: evt.color,
          '--fscale': evt.scale,
        }"
      >
        {{ evt.text }}
      </div>
    </div>

    <!-- 隐藏/小窗镜像摄像头与骨骼叠加层（体感模式时在右下角显示） -->
    <div
      class="camera-pip"
      :class="{ visible: isPlaying && selectedMode === 'camera' }"
    >
      <video ref="videoRef" autoplay playsinline muted class="pip-video" />
      <canvas ref="poseCanvasRef" width="240" height="180" class="pip-skeleton" />
      <div class="pip-status" :class="{ tracked: hud.tracking }">
        <span class="pip-dot" />
        <span>{{ t(`message.ultramanView.hints.${hud.poseHintKey}`) }}</span>
      </div>
      <div v-if="hud.chargeKind && hud.chargeProgress > 0.05" class="pip-charge-bar">
        <div
          class="pip-charge-fill"
          :class="hud.chargeKind"
          :style="{ width: Math.round(hud.chargeProgress * 100) + '%' }"
        />
      </div>
    </div>

    <!-- 开始菜单遮罩 -->
    <div v-if="hud.phase === 'menu'" class="menu-overlay">
      <div class="menu-card">
        <div class="menu-top-row">
          <button class="arcade-btn ghost" @click="handleGoHome">
            &lt; {{ t('message.ultramanView.back') }}
          </button>
          <span class="arcade-badge">3D MOTION · TIGA</span>
        </div>

        <h1 class="menu-title">{{ t('message.ultramanView.title') }}</h1>
        <p class="menu-subtitle">{{ t('message.ultramanView.subtitle') }}</p>

        <!-- 控制模式切换 -->
        <div class="mode-switch">
          <button
            class="mode-pill"
            :class="{ active: selectedMode === 'camera' }"
            @click="selectedMode = 'camera'"
          >
            {{ t('message.ultramanView.cameraMode') }}
          </button>
          <button
            class="mode-pill"
            :class="{ active: selectedMode === 'keyboard' }"
            @click="selectedMode = 'keyboard'"
          >
            {{ t('message.ultramanView.keyboardMode') }}
          </button>
        </div>

        <!-- 选关怪兽条 -->
        <div class="stage-picker">
          <div class="picker-label">{{ t('message.ultramanView.selectStage') }}</div>
          <div class="stage-pills">
            <button
              v-for="(m, idx) in MONSTER_WAVES"
              :key="m.id"
              class="stage-chip"
              :class="{ active: selectedWave === idx }"
              @click="selectedWave = idx"
            >
              <span class="chip-num">#{{ idx + 1 }}</span>
              <span>{{ t(`message.ultramanView.monsters.${m.id}`) }}</span>
            </button>
          </div>
        </div>

        <!-- 5 个动作图示教学 -->
        <div class="moves-grid">
          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="14" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M32 20v18m0 0-9 18m9-18 9 18" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M32 25l-12 4m12-4 17-5" stroke="#facc15" stroke-width="3.5" stroke-linecap="round" />
              <circle cx="51" cy="19" r="4" fill="#facc15" />
            </svg>
            <div class="move-name">{{ t('message.ultramanView.moves.punch') }}</div>
            <div class="move-desc">{{ t('message.ultramanView.moves.punchDesc') }}</div>
          </div>

          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="38" cy="15" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M36 21l-4 17m0 0-8 18m8-18 10 18" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M12 30h12m-12 0 5-5m-5 5 5 5" stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <div class="move-name">{{ t('message.ultramanView.moves.dodge') }}</div>
            <div class="move-desc">{{ t('message.ultramanView.moves.dodgeDesc') }}</div>
          </div>

          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="13" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M32 19v20m0 0-8 17m8-17 8 17" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M22 24l20 14M42 24L22 38" stroke="#38bdf8" stroke-width="4" stroke-linecap="round" />
            </svg>
            <div class="move-name">{{ t('message.ultramanView.moves.guard') }}</div>
            <div class="move-desc">{{ t('message.ultramanView.moves.guardDesc') }}</div>
          </div>

          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="18" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M32 24v16m0 0-8 16m8-16 8 16" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M32 27l12-16" stroke="#67e8f9" stroke-width="3.5" stroke-linecap="round" />
              <circle cx="44" cy="9" r="5" stroke="#67e8f9" stroke-width="2.5" stroke-dasharray="3 2" />
            </svg>
            <div class="move-name">{{ t('message.ultramanView.moves.disc') }}</div>
            <div class="move-desc">{{ t('message.ultramanView.moves.discDesc') }}</div>
          </div>

          <div class="move-card highlight">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="30" cy="14" r="6" stroke="#facc15" stroke-width="3" />
              <path d="M30 20v18m0 0-8 18m8-18 8 18" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M18 32h22M38 18v18" stroke="#38e8ff" stroke-width="4.5" stroke-linecap="round" />
              <circle cx="38" cy="28" r="5" fill="#fef08a" opacity="0.85" />
            </svg>
            <div class="move-name">{{ t('message.ultramanView.moves.beam') }}</div>
            <div class="move-desc">{{ t('message.ultramanView.moves.beamDesc') }}</div>
          </div>
        </div>

        <!-- 摄像头错误提示 -->
        <div v-if="cameraError" class="camera-error-box">
          <div class="error-msg">
            {{ t('message.ultramanView.cameraError') }} {{ cameraError }}
          </div>
          <button class="arcade-btn warn" @click="handleStartBattle('keyboard')">
            {{ t('message.ultramanView.switchToKeyboard') }}
          </button>
        </div>

        <button
          class="transform-btn"
          :disabled="startingCamera"
          @click="handleStartBattle()"
        >
          {{ startingCamera ? t('message.ultramanView.loadingModel') : t('message.ultramanView.startButton') }}
        </button>
      </div>
    </div>

    <!-- 加载中遮罩 -->
    <div v-if="hud.phase === 'loading'" class="loading-overlay">
      <div class="loading-card">
        <div class="loading-title">{{ t('message.ultramanView.loadingModel') }}</div>
        <div class="loading-track">
          <div class="loading-fill" :style="{ width: hud.loadingProgress + '%' }" />
        </div>
        <div class="loading-pct">{{ hud.loadingProgress }}%</div>
      </div>
    </div>

    <!-- 战斗 HUD 界面 -->
    <div v-if="isPlaying" class="battle-hud">
      <!-- 顶部栏：左操作与得分 / 中央 Boss 大红血条 / 右侧工具 -->
      <div class="hud-top">
        <div class="hud-top-left">
          <button class="arcade-btn" @click="handleGoHome">&lt; {{ t('message.ultramanView.back') }}</button>
          <div class="score-chip">
            <span class="chip-label">{{ t('message.ultramanView.score') }}</span>
            <span class="chip-val">{{ hud.score }}</span>
          </div>
          <div v-if="hud.combo >= 2" :key="hud.combo" class="combo-pill">
            {{ hud.combo }} {{ t('message.ultramanView.combo') }}
          </div>
        </div>

        <div class="boss-bar-wrap">
          <div class="boss-header">
            <span class="wave-badge">
              {{ t('message.ultramanView.wave', { current: hud.waveIndex + 1, total: hud.totalWaves }) }}
            </span>
            <span class="boss-name">{{ currentMonsterName }}</span>
            <span class="boss-hp-num">{{ hud.monsterHp }} / {{ hud.monsterMaxHp }}</span>
          </div>
          <div class="boss-hp-track">
            <div class="boss-hp-fill" :style="{ width: monsterHpPercent + '%' }" />
          </div>
        </div>

        <div class="hud-top-right">
          <button class="arcade-btn" @click="toggleMute">
            {{ muted ? t('message.ultramanView.mute') : t('message.ultramanView.unmute') }}
          </button>
          <button
            v-if="selectedMode === 'camera'"
            class="arcade-btn"
            @click="handleRecenter"
          >
            {{ t('message.ultramanView.recenter') }}
          </button>
          <button
            v-if="selectedMode === 'camera'"
            class="arcade-btn"
            :class="{ active: showSkeleton }"
            @click="showSkeleton = !showSkeleton"
          >
            {{ t('message.ultramanView.skeleton') }}
          </button>
          <button class="arcade-btn danger" @click="handleExitToMenu">
            {{ t('message.ultramanView.stop') }}
          </button>
        </div>
      </div>

      <!-- 怪兽攻击危险预警条 -->
      <div v-if="hud.warningTextKey" class="warning-banner">
        <div class="warning-text">
          {{ t(`message.ultramanView.warnings.${hud.warningTextKey}`) }}
        </div>
        <div class="warning-meter">
          <div class="warning-fill" :style="{ width: Math.round(hud.warningUrgency * 100) + '%' }" />
        </div>
      </div>

      <!-- 招式特摄大字播报 -->
      <div
        v-if="hud.activeSkillBannerKey"
        :key="hud.activeSkillBannerKey"
        class="skill-banner"
        :class="{ 'below-warning': !!hud.warningTextKey }"
      >
        {{ t(`message.ultramanView.banners.${hud.activeSkillBannerKey}`) }}
      </div>

      <!-- 左下角：迪迦彩色计时器 + 血量条 + 必杀光线能量槽 -->
      <div class="hero-status-panel">
        <div class="color-timer" :class="{ danger: hud.timerDanger }">
          <div class="color-timer-core" />
        </div>
        <div class="hero-bars">
          <div class="bar-row">
            <span class="bar-label">{{ t('message.ultramanView.heroHp') }}</span>
            <span class="bar-num">{{ hud.heroHp }} / {{ hud.heroMaxHp }}</span>
          </div>
          <div class="hero-hp-track">
            <div
              class="hero-hp-fill"
              :class="{ low: hud.timerDanger }"
              :style="{ width: heroHpPercent + '%' }"
            />
          </div>

          <div class="bar-row energy-row">
            <span class="bar-label">{{ t('message.ultramanView.energy') }}</span>
            <span class="energy-tip" :class="{ full: hud.energy >= 100, ready: hud.energy >= 35 }">
              {{
                hud.energy >= 100
                  ? t('message.ultramanView.energyFull')
                  : hud.energy >= 35
                    ? t('message.ultramanView.energyReady')
                    : hud.energy + '%'
              }}
            </span>
          </div>
          <div class="energy-track">
            <div
              class="energy-fill"
              :class="{ full: hud.energy >= 100, ready: hud.energy >= 35 }"
              :style="{ width: hud.energy + '%' }"
            />
          </div>
        </div>
      </div>

      <!-- 键盘 / 触屏快捷操作区（仅在键盘模式下常驻显示） -->
      <div v-if="selectedMode === 'keyboard'" class="manual-controls">
        <div class="keyboard-hint">{{ t('message.ultramanView.controls.keyboardHint') }}</div>
        <div class="touch-row">
          <div class="touch-group">
            <button
              class="pad-btn"
              @pointerdown.prevent="onTouchLean(-1)"
              @pointerup="onTouchLean(0)"
              @pointerleave="onTouchLean(0)"
            >
              &lt; {{ t('message.ultramanView.controls.left') }}
            </button>
            <button
              class="pad-btn shield"
              @pointerdown.prevent="onTouchGuard(true)"
              @pointerup="onTouchGuard(false)"
              @pointerleave="onTouchGuard(false)"
            >
              {{ t('message.ultramanView.controls.guard') }}
            </button>
            <button
              class="pad-btn"
              @pointerdown.prevent="onTouchLean(1)"
              @pointerup="onTouchLean(0)"
              @pointerleave="onTouchLean(0)"
            >
              {{ t('message.ultramanView.controls.right') }} &gt;
            </button>
          </div>
          <div class="touch-group">
            <button class="pad-btn punch" @click="onTouchPunch('left')">
              {{ t('message.ultramanView.controls.punchL') }}
            </button>
            <button class="pad-btn punch" @click="onTouchPunch('right')">
              {{ t('message.ultramanView.controls.punchR') }}
            </button>
            <button class="pad-btn disc" @click="onTouchDisc">
              {{ t('message.ultramanView.controls.disc') }}
            </button>
            <button
              class="pad-btn beam"
              :class="{ ready: hud.energy >= 35, full: hud.energy >= 100 }"
              @click="onTouchBeam"
            >
              {{ t('message.ultramanView.controls.beam') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 通关 / 战败结算面板 -->
    <div v-if="hud.phase === 'victory' || hud.phase === 'defeat'" class="result-overlay">
      <div class="result-card" :class="hud.phase">
        <h2 class="result-title">
          {{
            hud.phase === 'victory'
              ? t('message.ultramanView.result.victoryTitle')
              : t('message.ultramanView.result.defeatTitle')
          }}
        </h2>

        <div class="result-stats">
          <div class="stat-box">
            <div class="stat-label">{{ t('message.ultramanView.result.totalScore') }}</div>
            <div class="stat-value gold">{{ hud.score }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">{{ t('message.ultramanView.result.defeated') }}</div>
            <div class="stat-value">{{ hud.defeatedCount }} / {{ hud.totalWaves }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">{{ t('message.ultramanView.result.maxCombo') }}</div>
            <div class="stat-value">{{ hud.maxCombo }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">{{ t('message.ultramanView.result.perfectGuards') }}</div>
            <div class="stat-value cyan">{{ hud.perfectGuards }}</div>
          </div>
        </div>

        <div class="result-actions">
          <button class="transform-btn small" @click="handleStartBattle()">
            {{ t('message.ultramanView.result.playAgain') }}
          </button>
          <button class="arcade-btn ghost large" @click="handleGoHome">
            {{ t('message.ultramanView.result.backHome') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ultraman-page {
  position: fixed;
  inset: 0;
  z-index: 1500;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #0b192c;
  color: #f8fafc;
  user-select: none;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif;
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
  z-index: 25;
  overflow: hidden;
}

.floating-text {
  position: absolute;
  transform: translate(-50%, -50%) scale(var(--fscale, 1));
  font-size: 30px;
  font-weight: 900;
  letter-spacing: 1px;
  text-shadow:
    0 3px 0 #000,
    0 0 14px rgba(0, 0, 0, 0.85);
  animation: floatUp 0.95s ease-out forwards;
  white-space: nowrap;
}

@keyframes floatUp {
  0% {
    opacity: 0;
    transform: translate(-50%, -30%) scale(calc(var(--fscale, 1) * 0.7));
  }
  18% {
    opacity: 1;
    transform: translate(-50%, -65%) scale(calc(var(--fscale, 1) * 1.15));
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -175%) scale(var(--fscale, 1));
  }
}

/* ---- 迷你镜像摄像头 + 骨骼窗 ---- */
.camera-pip {
  position: fixed;
  right: 18px;
  bottom: 18px;
  width: 224px;
  border-radius: 12px;
  overflow: hidden;
  background: rgba(8, 15, 28, 0.88);
  border: 2px solid rgba(56, 232, 255, 0.7);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
  z-index: 35;
  opacity: 0;
  pointer-events: none;
  transform: translateY(12px);
  transition: opacity 0.25s, transform 0.25s;
}

.camera-pip.visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.pip-video {
  display: block;
  width: 224px;
  height: 168px;
  object-fit: cover;
  transform: scaleX(-1);
}

.pip-skeleton {
  position: absolute;
  top: 0;
  left: 0;
  width: 224px;
  height: 168px;
  pointer-events: none;
}

.pip-status {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(15, 23, 42, 0.92);
  color: #cbd5e1;
}

.pip-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f97316;
  flex-shrink: 0;
}

.pip-status.tracked .pip-dot {
  background: #22c55e;
  box-shadow: 0 0 8px #22c55e;
}

.pip-charge-bar {
  height: 5px;
  background: rgba(255, 255, 255, 0.16);
}

.pip-charge-fill {
  height: 100%;
  transition: width 0.08s linear;
}

.pip-charge-fill.beam {
  background: linear-gradient(90deg, #38bdf8, #facc15);
}

.pip-charge-fill.disc {
  background: #67e8f9;
}

.pip-charge-fill.guard {
  background: #38bdf8;
}

/* ---- 开始菜单遮罩 ---- */
.menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: radial-gradient(circle at 50% 35%, rgba(12, 27, 51, 0.35), rgba(6, 12, 26, 0.82));
}

.menu-card {
  width: min(820px, 95vw);
  max-height: 92vh;
  overflow-y: auto;
  padding: 24px 28px;
  border-radius: 18px;
  background: rgba(10, 20, 38, 0.88);
  backdrop-filter: blur(12px);
  border: 2px solid rgba(56, 232, 255, 0.55);
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.65),
    inset 0 0 28px rgba(56, 189, 248, 0.12);
  text-align: center;
}

.menu-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}

.arcade-badge {
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 1.5px;
  color: #0b192c;
  background: linear-gradient(90deg, #38e8ff, #facc15);
}

.menu-title {
  margin: 4px 0 8px;
  font-size: clamp(26px, 4vw, 38px);
  font-weight: 900;
  letter-spacing: 1px;
  background: linear-gradient(180deg, #ffffff 15%, #7dd3fc 75%, #38bdf8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.menu-subtitle {
  margin: 0 0 16px;
  font-size: 14px;
  color: #cbd5e1;
}

.mode-switch {
  display: inline-flex;
  gap: 8px;
  padding: 5px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.08);
  margin-bottom: 14px;
}

.mode-pill {
  padding: 9px 20px;
  border: none;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 800;
  color: #cbd5e1;
  background: transparent;
  cursor: pointer;
  transition: all 0.15s;
}

.mode-pill.active {
  color: #091325;
  background: linear-gradient(90deg, #38e8ff, #7dd3fc);
  box-shadow: 0 4px 14px rgba(56, 232, 255, 0.4);
}

.stage-picker {
  margin-bottom: 16px;
}

.picker-label {
  font-size: 12px;
  font-weight: 700;
  color: #94a3b8;
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}

.stage-pills {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.stage-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1.5px solid rgba(148, 163, 184, 0.35);
  background: rgba(15, 23, 42, 0.72);
  color: #e2e8f0;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s;
}

.stage-chip.active {
  border-color: #facc15;
  background: rgba(250, 204, 21, 0.18);
  color: #fef08a;
}

.chip-num {
  color: #38e8ff;
  font-weight: 900;
}

.moves-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 18px;
}

.move-card {
  padding: 10px 8px;
  border-radius: 12px;
  background: rgba(30, 41, 59, 0.65);
  border: 1.5px solid rgba(148, 163, 184, 0.25);
}

.move-card.highlight {
  border-color: rgba(250, 204, 21, 0.7);
  background: linear-gradient(180deg, rgba(56, 189, 248, 0.18), rgba(250, 204, 21, 0.12));
}

.pose-svg {
  width: 48px;
  height: 48px;
  display: block;
  margin: 0 auto 4px;
}

.move-name {
  font-size: 12px;
  font-weight: 800;
  color: #f8fafc;
}

.move-desc {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 2px;
}

.camera-error-box {
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(220, 38, 38, 0.2);
  border: 1.5px solid rgba(248, 113, 113, 0.7);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.error-msg {
  font-size: 13px;
  color: #fecaca;
}

.transform-btn {
  padding: 14px 44px;
  border: none;
  border-radius: 999px;
  font-size: 18px;
  font-weight: 900;
  letter-spacing: 2px;
  color: #091325;
  background: linear-gradient(90deg, #38e8ff 0%, #facc15 50%, #fb923c 100%);
  box-shadow: 0 10px 28px rgba(56, 232, 255, 0.45);
  cursor: pointer;
  transition: transform 0.14s, box-shadow 0.14s;
}

.transform-btn:hover:not(:disabled) {
  transform: translateY(-2px) scale(1.03);
  box-shadow: 0 14px 36px rgba(250, 204, 21, 0.55);
}

.transform-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

.transform-btn.small {
  padding: 12px 28px;
  font-size: 15px;
}

/* ---- 加载遮罩 ---- */
.loading-overlay {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 15, 28, 0.78);
  backdrop-filter: blur(6px);
}

.loading-card {
  width: min(360px, 85vw);
  padding: 24px;
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.94);
  border: 2px solid #38e8ff;
  text-align: center;
}

.loading-title {
  font-size: 16px;
  font-weight: 800;
  margin-bottom: 12px;
}

.loading-track {
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.14);
}

.loading-fill {
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #facc15);
  transition: width 0.2s ease;
}

.loading-pct {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 800;
  color: #7dd3fc;
}

/* ---- 战斗 HUD ---- */
.battle-hud {
  position: fixed;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.hud-top {
  display: grid;
  grid-template-columns: minmax(180px, 1fr) minmax(260px, 520px) minmax(180px, 1fr);
  align-items: start;
  gap: 12px;
}

.hud-top-left,
.hud-top-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  pointer-events: auto;
}

.hud-top-right {
  justify-content: flex-end;
}

.arcade-btn {
  padding: 7px 13px;
  border-radius: 8px;
  border: 1.5px solid rgba(148, 163, 184, 0.45);
  background: rgba(15, 23, 42, 0.82);
  color: #f8fafc;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.arcade-btn:hover {
  background: rgba(30, 41, 59, 0.95);
  border-color: #38e8ff;
}

.arcade-btn.active {
  border-color: #38e8ff;
  color: #38e8ff;
}

.arcade-btn.danger {
  border-color: rgba(248, 113, 113, 0.7);
  background: rgba(153, 27, 27, 0.78);
}

.arcade-btn.warn {
  border-color: #facc15;
  background: #facc15;
  color: #091325;
}

.arcade-btn.ghost {
  background: rgba(15, 23, 42, 0.65);
}

.arcade-btn.large {
  padding: 12px 24px;
  font-size: 14px;
}

.score-chip {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.82);
  border: 1.5px solid rgba(250, 204, 21, 0.55);
}

.chip-label {
  font-size: 10px;
  font-weight: 800;
  color: #94a3b8;
}

.chip-val {
  font-size: 17px;
  font-weight: 900;
  color: #fde047;
}

.combo-pill {
  padding: 5px 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, #f97316, #facc15);
  color: #091325;
  font-size: 13px;
  font-weight: 900;
  animation: comboPop 0.2s ease-out;
}

@keyframes comboPop {
  0% {
    transform: scale(1.35);
  }
  100% {
    transform: scale(1);
  }
}

/* 顶部中央 Boss 大红血条（致敬商场机台视觉） */
.boss-bar-wrap {
  background: rgba(10, 18, 34, 0.82);
  border: 2px solid rgba(248, 113, 113, 0.75);
  border-radius: 12px;
  padding: 8px 14px 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
}

.boss-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.wave-badge {
  padding: 2px 8px;
  border-radius: 6px;
  background: #dc2626;
  color: #fff;
  font-size: 11px;
  font-weight: 900;
}

.boss-name {
  font-size: 16px;
  font-weight: 900;
  letter-spacing: 1px;
  color: #fff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
}

.boss-hp-num {
  font-size: 12px;
  font-weight: 800;
  color: #fca5a5;
}

.boss-hp-track {
  height: 16px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.65);
  border: 1.5px solid rgba(255, 255, 255, 0.25);
  overflow: hidden;
}

.boss-hp-fill {
  height: 100%;
  background: linear-gradient(90deg, #b91c1c 0%, #ef4444 55%, #fb923c 100%);
  box-shadow: 0 0 14px rgba(239, 68, 68, 0.85);
  transition: width 0.16s ease-out;
}

/* 危险预警条 */
.warning-banner {
  position: fixed;
  top: 94px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 20px;
  border-radius: 10px;
  background: rgba(185, 28, 28, 0.92);
  border: 2px solid #fef08a;
  box-shadow: 0 0 26px rgba(239, 68, 68, 0.85);
  text-align: center;
  min-width: 280px;
  animation: warnPulse 0.45s ease-in-out infinite alternate;
}

@keyframes warnPulse {
  from {
    transform: translateX(-50%) scale(1);
  }
  to {
    transform: translateX(-50%) scale(1.04);
  }
}

.warning-text {
  font-size: 15px;
  font-weight: 900;
  color: #fff;
  margin-bottom: 5px;
}

.warning-meter {
  height: 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.warning-fill {
  height: 100%;
  background: #facc15;
}

/* 招式播报大字（位于上方偏高处，不遮挡怪兽正面；有预警条时自动下移避免重叠） */
.skill-banner {
  position: fixed;
  top: 100px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 24px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(14, 116, 144, 0.88), rgba(37, 99, 235, 0.88));
  border: 2px solid #fef08a;
  font-size: clamp(18px, 2.5vw, 26px);
  font-weight: 900;
  letter-spacing: 2px;
  color: #fef9c3;
  text-shadow: 0 2px 0 #091325;
  box-shadow: 0 0 26px rgba(56, 232, 255, 0.65);
  animation: bannerIn 0.25s ease-out;
  white-space: nowrap;
}

.skill-banner.below-warning {
  top: 162px;
}

@keyframes bannerIn {
  from {
    opacity: 0;
    transform: translateX(-50%) scale(0.75);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
}

/* 左下角：迪迦彩色计时器与血条/能量槽 */
.hero-status-panel {
  display: flex;
  align-items: center;
  gap: 14px;
  width: min(360px, 60vw);
  padding: 12px 16px;
  border-radius: 14px;
  background: rgba(10, 20, 38, 0.84);
  border: 2px solid rgba(56, 232, 255, 0.6);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.48);
}

.color-timer {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle, #7dd3fc 0%, #0284c7 65%, #082f49 100%);
  border: 3px solid #e2e8f0;
  box-shadow: 0 0 18px rgba(56, 232, 255, 0.85);
}

.color-timer-core {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #e0f2fe;
  box-shadow: 0 0 12px #38e8ff;
}

.color-timer.danger {
  background: radial-gradient(circle, #fca5a5 0%, #dc2626 65%, #450a0a 100%);
  box-shadow: 0 0 22px rgba(239, 68, 68, 0.95);
  animation: timerBlink 0.55s ease-in-out infinite alternate;
}

.color-timer.danger .color-timer-core {
  background: #fecaca;
}

@keyframes timerBlink {
  from {
    opacity: 1;
    transform: scale(1.06);
  }
  to {
    opacity: 0.45;
    transform: scale(0.95);
  }
}

.hero-bars {
  flex: 1;
  min-width: 0;
}

.bar-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  font-weight: 800;
  margin-bottom: 4px;
}

.bar-label {
  color: #cbd5e1;
}

.bar-num {
  color: #7dd3fc;
}

.hero-hp-track,
.energy-track {
  height: 11px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.hero-hp-fill {
  height: 100%;
  background: linear-gradient(90deg, #0284c7, #38e8ff);
  transition: width 0.2s ease;
}

.hero-hp-fill.low {
  background: linear-gradient(90deg, #dc2626, #f97316);
}

.energy-row {
  margin-top: 8px;
}

.energy-tip {
  color: #94a3b8;
  font-size: 11px;
}

.energy-tip.ready {
  color: #38e8ff;
}

.energy-tip.full {
  color: #fde047;
  animation: timerBlink 0.6s infinite alternate;
}

.energy-fill {
  height: 100%;
  background: #64748b;
  transition: width 0.16s ease;
}

.energy-fill.ready {
  background: linear-gradient(90deg, #0ea5e9, #67e8f9);
}

.energy-fill.full {
  background: linear-gradient(90deg, #38e8ff, #facc15, #fb923c);
  box-shadow: 0 0 12px #facc15;
}

/* 键盘/触屏快捷按钮区 */
.manual-controls {
  position: fixed;
  right: 18px;
  bottom: 18px;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.keyboard-hint {
  font-size: 11px;
  font-weight: 700;
  color: #e2e8f0;
  background: rgba(10, 20, 38, 0.78);
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid rgba(148, 163, 184, 0.35);
}

.touch-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.touch-group {
  display: flex;
  gap: 6px;
}

.pad-btn {
  padding: 10px 14px;
  border-radius: 10px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  background: rgba(15, 23, 42, 0.86);
  color: #f8fafc;
  font-size: 13px;
  font-weight: 900;
  cursor: pointer;
  touch-action: none;
}

.pad-btn:active {
  transform: scale(0.95);
}

.pad-btn.shield {
  border-color: #38bdf8;
  color: #7dd3fc;
}

.pad-btn.punch {
  border-color: #fb923c;
  background: rgba(154, 52, 18, 0.8);
}

.pad-btn.disc {
  border-color: #22d3ee;
  background: rgba(14, 116, 144, 0.82);
}

.pad-btn.beam {
  border-color: #64748b;
  opacity: 0.7;
}

.pad-btn.beam.ready {
  opacity: 1;
  border-color: #38e8ff;
  background: linear-gradient(135deg, #0284c7, #2563eb);
}

.pad-btn.beam.full {
  border-color: #fef08a;
  background: linear-gradient(135deg, #f59e0b, #ef4444);
  box-shadow: 0 0 18px rgba(250, 204, 21, 0.8);
}

/* ---- 结算面板 ---- */
.result-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(6, 12, 26, 0.72);
  backdrop-filter: blur(8px);
}

.result-card {
  width: min(520px, 92vw);
  padding: 28px;
  border-radius: 18px;
  background: rgba(10, 20, 38, 0.94);
  border: 2px solid #38e8ff;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65);
  text-align: center;
}

.result-card.victory {
  border-color: #facc15;
}

.result-title {
  margin: 0 0 20px;
  font-size: 28px;
  font-weight: 900;
  color: #fef08a;
}

.result-card.defeat .result-title {
  color: #fca5a5;
}

.result-stats {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}

.stat-box {
  padding: 14px;
  border-radius: 12px;
  background: rgba(30, 41, 59, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.25);
}

.stat-label {
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 24px;
  font-weight: 900;
}

.stat-value.gold {
  color: #fde047;
}

.stat-value.cyan {
  color: #38e8ff;
}

.result-actions {
  display: flex;
  justify-content: center;
  gap: 14px;
  flex-wrap: wrap;
}

@media (max-width: 820px) {
  .moves-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .hud-top {
    grid-template-columns: 1fr;
  }
  .hud-top-right {
    justify-content: flex-start;
  }
  .hero-status-panel {
    width: calc(100vw - 36px);
  }
  .camera-pip {
    width: 156px;
  }
  .pip-video,
  .pip-skeleton {
    width: 156px;
    height: 117px;
  }
}
</style>
