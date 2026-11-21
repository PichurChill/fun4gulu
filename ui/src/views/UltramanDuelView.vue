<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { UltramanDuelEngine } from '@/games/ultraman-duel/engine'
import { MultiPoseCamera } from '@/games/ultraman-duel/poseCamera'
import type { DetectedPose } from '@/games/ultraman-duel/poseCamera'
import type { DuelHudState, DuelMode, FloatingDamageEvent, PlayerSlot } from '@/games/ultraman-duel/types'

const router = useRouter()
const { t } = useI18n()

// ---- DOM 引用 ----
const stageRef = ref<HTMLElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const poseCanvasRef = ref<HTMLCanvasElement | null>(null)

// ---- 交互状态 ----
const selectedMode = ref<DuelMode>('duel')
const muted = ref(false)
const showSkeleton = ref(true)
const cameraError = ref<string | null>(null)
const startingCamera = ref(false)
const floatingEvents = ref<FloatingDamageEvent[]>([])

const hud = reactive<DuelHudState>({
  phase: 'menu',
  loadingProgress: 0,
  mode: 'duel',
  round: 1,
  wins: [0, 0],
  roundTimeLeft: 75,
  hp: [120, 120],
  maxHp: 120,
  energy: [40, 40],
  combo: [0, 0],
  score: [0, 0],
  sources: ['camera', 'camera'],
  tracking: [false, false],
  bodyCoverage: ['none', 'none'],
  poseHintKey: ['hintStandCenter', 'hintStandCenter'],
  dangerTimer: [false, false],
  chargeKind: [null, null],
  chargeProgress: [0, 0],
  activeBannerKey: null,
  winnerSlot: null,
})

const hpPercent = (slot: PlayerSlot) =>
  hud.maxHp > 0 ? Math.max(0, Math.min(100, (hud.hp[slot] / hud.maxHp) * 100)) : 0

const isPlaying = computed(
  () => hud.phase === 'round-intro' || hud.phase === 'fighting' || hud.phase === 'ko',
)
const isCameraMode = computed(
  () => hud.sources[0] === 'camera' || hud.sources[1] === 'camera',
)
const timerDanger = computed(() => hud.roundTimeLeft <= 10 && hud.phase === 'fighting')

const bannerText = computed(() => {
  if (!hud.activeBannerKey) return ''
  if (hud.activeBannerKey === 'bannerRound') {
    return t('message.ultramanDuelView.banners.bannerRound', { round: hud.round })
  }
  return t(`message.ultramanDuelView.banners.${hud.activeBannerKey}`)
})

const sourceBadge = (slot: PlayerSlot) => {
  const src = hud.sources[slot]
  if (src === 'cpu') return t('message.ultramanDuelView.cpuTag')
  if (src === 'keyboard') return t('message.ultramanDuelView.tagKey')
  return t('message.ultramanDuelView.tagCam')
}

const winnerText = computed(() => {
  if (hud.winnerSlot === null) return ''
  return t(`message.ultramanDuelView.banners.bannerMatchWinP${hud.winnerSlot + 1}`)
})

// ---- 运行时句柄 ----
let engine: UltramanDuelEngine | null = null
const poseCamera = new MultiPoseCamera()
let poseCtx: CanvasRenderingContext2D | null = null
const floatTimers = new Map<number, number>()

// 双人槽位分配（镜像画面左 = P1，右 = P2；单人模式恒 P1）
const slotCenters: [number | null, number | null] = [null, null]

function assignSlots(poses: DetectedPose[]): [DetectedPose | null, DetectedPose | null] {
  const out: [DetectedPose | null, DetectedPose | null] = [null, null]
  if (poses.length === 0) {
    slotCenters[0] = null
    slotCenters[1] = null
    return out
  }
  if (poses.length === 1) {
    const p = poses[0]!
    let slot: PlayerSlot = 0
    if (selectedMode.value !== 'solo' && slotCenters[0] !== null && slotCenters[1] !== null) {
      slot =
        Math.abs(p.mirroredCenterX - slotCenters[0]!) <=
        Math.abs(p.mirroredCenterX - slotCenters[1]!)
          ? 0
          : 1
    } else if (selectedMode.value !== 'solo' && slotCenters[1] !== null && slotCenters[0] === null) {
      slot = 1
    }
    out[slot] = p
    slotCenters[slot] = slotCenters[slot] === null ? p.mirroredCenterX : slotCenters[slot]! * 0.85 + p.mirroredCenterX * 0.15
    return out
  }
  // 两人同框：按水平位置排（左 = P1），但中心间距过近时沿用上一帧就近匹配防抖
  const [a, b] = [poses[0]!, poses[1]!]
  if (
    Math.abs(a.mirroredCenterX - b.mirroredCenterX) < 0.1 &&
    slotCenters[0] !== null &&
    slotCenters[1] !== null
  ) {
    const keep = Math.abs(a.mirroredCenterX - slotCenters[0]!) + Math.abs(b.mirroredCenterX - slotCenters[1]!)
    const swap = Math.abs(b.mirroredCenterX - slotCenters[0]!) + Math.abs(a.mirroredCenterX - slotCenters[1]!)
    if (swap < keep) {
      out[0] = b
      out[1] = a
    } else {
      out[0] = a
      out[1] = b
    }
  } else {
    out[0] = a
    out[1] = b
  }
  slotCenters[0] = slotCenters[0] === null ? out[0]!.mirroredCenterX : slotCenters[0]! * 0.85 + out[0]!.mirroredCenterX * 0.15
  slotCenters[1] = slotCenters[1] === null ? out[1]!.mirroredCenterX : slotCenters[1]! * 0.85 + out[1]!.mirroredCenterX * 0.15
  return out
}

// ---- 双人骨骼绘制（P1 青 / P2 橙） ----
const SKELETON_LINKS: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
  [24, 26], [26, 28], [27, 29], [28, 30], [0, 11], [0, 12],
]

function drawSkeletons(slots: [DetectedPose | null, DetectedPose | null]) {
  const canvas = poseCanvasRef.value
  if (!canvas) return
  if (!poseCtx) poseCtx = canvas.getContext('2d')
  const ctx = poseCtx
  if (!ctx) return

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!showSkeleton.value) return
  ctx.save()
  ctx.translate(canvas.width, 0)
  ctx.scale(-1, 1)

  const colors = ['#38e8ff', '#fb923c']
  slots.forEach((pose, slot) => {
    if (!pose) return
    const color = colors[slot]!
    ctx.strokeStyle = color
    ctx.lineWidth = 2.5
    for (const [from, to] of SKELETON_LINKS) {
      const a = pose.landmarks[from]!
      const b = pose.landmarks[to]!
      if ((a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue
      ctx.beginPath()
      ctx.moveTo(a.x * canvas.width, a.y * canvas.height)
      ctx.lineTo(b.x * canvas.width, b.y * canvas.height)
      ctx.stroke()
    }
    ctx.fillStyle = slot === 0 ? '#facc15' : '#fef08a'
    for (const lm of pose.landmarks) {
      if ((lm.visibility ?? 1) < 0.4) continue
      ctx.beginPath()
      ctx.arc(lm.x * canvas.width, lm.y * canvas.height, 2.6, 0, Math.PI * 2)
      ctx.fill()
    }
    // P1/P2 标签画在肩部中点
    const ls = pose.landmarks[11]!
    ctx.fillStyle = color
    ctx.font = 'bold 13px sans-serif'
    ctx.fillText(`P${slot + 1}`, ls.x * canvas.width - 8, ls.y * canvas.height - 8)
  })
  ctx.restore()
}

function handlePoses(poses: DetectedPose[], now: number) {
  if (!engine || !videoRef.value) return
  const slots = assignSlots(poses)
  drawSkeletons(slots)
  const w = videoRef.value.videoWidth || 640
  const h = videoRef.value.videoHeight || 480
  for (const slot of [0, 1] as PlayerSlot[]) {
    const pose = slots[slot]
    if (pose) {
      engine.feedPoseFrame(slot, pose.landmarks, pose.worldLandmarks, now, w, h)
    }
  }
}

// ---- 游戏流程 ----
async function handleStartBattle(mode?: DuelMode, keyboardFallback = false) {
  if (!engine) return
  if (mode && !keyboardFallback) selectedMode.value = mode
  cameraError.value = null

  poseCamera.stop(videoRef.value)

  if (selectedMode.value !== 'keyboard' && !keyboardFallback) {
    startingCamera.value = true
    poseCamera.onPoses = handlePoses
    try {
      if (videoRef.value) await poseCamera.start(videoRef.value)
    } catch (err: unknown) {
      startingCamera.value = false
      const msg = err instanceof Error ? err.message : String(err)
      cameraError.value = msg
      return
    }
    startingCamera.value = false
  }

  await engine.startGame(selectedMode.value, { keyboardP1: keyboardFallback })
}

function handleExitToMenu() {
  poseCamera.stop(videoRef.value)
  engine?.stopToMenu()
}

function handleGoHome() {
  poseCamera.stop(videoRef.value)
  engine?.stopToMenu()
  void router.push('/')
}

function toggleMute() {
  muted.value = !muted.value
  engine?.setMuted(muted.value)
}

// ---- 触屏操作包装（模板不直接持有引擎句柄） ----
function recenterBoth() {
  engine?.recenterSlot(0)
  engine?.recenterSlot(1)
}
function padMove(slot: PlayerSlot, dir: -1 | 0 | 1) {
  engine?.setManualMove(slot, dir)
}
function padJump(slot: PlayerSlot) {
  engine?.triggerManualJump(slot)
}
function padGuard(slot: PlayerSlot, active: boolean) {
  engine?.setManualGuard(slot, active)
}
function padPunch(slot: PlayerSlot, side: 'left' | 'right') {
  engine?.triggerManualPunch(slot, side)
}
function padKick(slot: PlayerSlot) {
  engine?.triggerManualKick(slot, 'right')
}
function padDisc(slot: PlayerSlot) {
  engine?.triggerManualDisc(slot)
}
function padBeam(slot: PlayerSlot) {
  engine?.triggerManualBeam(slot)
}

// ---- 键盘（P1 / P2 双套键位，体感模式下也可随时辅助） ----
const p1MoveKeys = new Set<string>()
const p2MoveKeys = new Set<string>()

function updateManualMove() {
  const p1Left = p1MoveKeys.has('KeyA')
  const p1Right = p1MoveKeys.has('KeyD')
  const p2Left = p2MoveKeys.has('ArrowLeft')
  const p2Right = p2MoveKeys.has('ArrowRight')
  engine?.setManualMove(0, p1Left && !p1Right ? -1 : p1Right && !p1Left ? 1 : 0)
  engine?.setManualMove(1, p2Left && !p2Right ? -1 : p2Right && !p2Left ? 1 : 0)
}

function onKeyDown(e: KeyboardEvent) {
  if (!engine) return
  if (hud.phase !== 'fighting' && hud.phase !== 'round-intro') return
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
    e.preventDefault()
  }
  if (e.repeat) {
    p1MoveKeys.add(e.code)
    p2MoveKeys.add(e.code)
    updateManualMove()
    return
  }

  // P1：A/D 移动 · W 跳 · S 防御 · J/K 出拳 · I 飞踢 · U 光轮 · 空格 光线
  switch (e.code) {
    case 'KeyA':
    case 'KeyD':
      p1MoveKeys.add(e.code)
      updateManualMove()
      return
    case 'KeyW':
      engine.triggerManualJump(0)
      return
    case 'KeyS':
      engine.setManualGuard(0, true)
      return
    case 'KeyJ':
      engine.triggerManualPunch(0, 'left')
      return
    case 'KeyK':
      engine.triggerManualPunch(0, 'right')
      return
    case 'KeyI':
      engine.triggerManualKick(0, 'right')
      return
    case 'KeyU':
      engine.triggerManualDisc(0)
      return
    case 'Space':
      engine.triggerManualBeam(0)
      return
  }

  // P2：←/→ 移动 · ↑ 跳 · ↓ 防御 · 1/2 出拳 · 3 飞踢 · 4 光轮 · 5 光线
  switch (e.code) {
    case 'ArrowLeft':
    case 'ArrowRight':
      p2MoveKeys.add(e.code)
      updateManualMove()
      return
    case 'ArrowUp':
      engine.triggerManualJump(1)
      return
    case 'ArrowDown':
      engine.setManualGuard(1, true)
      return
    case 'Digit1':
      engine.triggerManualPunch(1, 'left')
      return
    case 'Digit2':
      engine.triggerManualPunch(1, 'right')
      return
    case 'Digit3':
      engine.triggerManualKick(1, 'right')
      return
    case 'Digit4':
      engine.triggerManualDisc(1)
      return
    case 'Digit5':
      engine.triggerManualBeam(1)
      return
  }
}

function onKeyUp(e: KeyboardEvent) {
  p1MoveKeys.delete(e.code)
  p2MoveKeys.delete(e.code)
  updateManualMove()
  if (e.code === 'KeyS') padGuard(0, false)
  if (e.code === 'ArrowDown') padGuard(1, false)
}

function onVisibilityChange() {
  if (!document.hidden && engine) {
    engine.recenterSlot(0)
    engine.recenterSlot(1)
  }
}

// ---- 生命周期 ----
onMounted(() => {
  if (!stageRef.value) return

  engine = new UltramanDuelEngine(stageRef.value, {
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

  // 进入页面立即静默预加载迪迦 + 赛罗双模型
  void engine.preloadDualAssets()

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
  poseCamera.stop(videoRef.value)
  engine?.dispose()
  engine = null
})
</script>

<template>
  <div class="ultraman-duel-page">
    <!-- 3D 横版擂台 -->
    <div ref="stageRef" class="stage-canvas-wrap" />

    <!-- 飘字层 -->
    <div class="floating-layer" aria-hidden="true">
      <div
        v-for="evt in floatingEvents"
        :key="evt.id"
        class="floating-text"
        :class="`p${evt.slot + 1}`"
        :style="{
          left: evt.x + '%',
          top: evt.y + '%',
          '--fscale': evt.scale,
        }"
      >
        {{ evt.text }}
      </div>
    </div>

    <!-- 双人镜像摄像头 PIP（体感模式） -->
    <div class="camera-pip" :class="{ visible: isPlaying && isCameraMode }">
      <video ref="videoRef" autoplay playsinline muted class="pip-video" />
      <canvas ref="poseCanvasRef" width="300" height="225" class="pip-skeleton" />
      <div class="pip-rows">
        <div v-for="slot in ([0, 1] as PlayerSlot[])" :key="slot" class="pip-row" :class="`p${slot + 1}`">
          <span class="pip-tag">P{{ slot + 1 }}</span>
          <span class="pip-dot" :class="{ tracked: hud.tracking[slot] }" />
          <span class="pip-hint">
            {{
              hud.tracking[slot]
                ? t(`message.ultramanDuelView.hints.${hud.poseHintKey[slot]}`)
                : slot === 1 && hud.sources[1] === 'cpu'
                  ? t('message.ultramanDuelView.cpuTag')
                  : t('message.ultramanDuelView.waiting')
            }}
          </span>
          <span
            v-if="hud.chargeKind[slot]"
            class="pip-charge"
            :class="[`p${slot + 1}`, hud.chargeKind[slot]!]"
          >
            {{ Math.round(hud.chargeProgress[slot] * 100) }}%
          </span>
        </div>
      </div>
    </div>

    <!-- 开始菜单 -->
    <div v-if="hud.phase === 'menu'" class="menu-overlay">
      <div class="menu-card">
        <div class="menu-top-row">
          <button class="arcade-btn ghost" @click="handleGoHome">
            &lt; {{ t('message.ultramanDuelView.back') }}
          </button>
          <span class="arcade-badge">SIDE-VIEW MOTION DUEL</span>
        </div>

        <h1 class="menu-title">{{ t('message.ultramanDuelView.title') }}</h1>
        <p class="menu-subtitle">{{ t('message.ultramanDuelView.subtitle') }}</p>

        <!-- 模式选择 -->
        <div class="mode-grid">
          <button
            class="mode-card"
            :class="{ active: selectedMode === 'duel' }"
            @click="selectedMode = 'duel'"
          >
            <div class="mode-name">{{ t('message.ultramanDuelView.modeDuel') }}</div>
            <div class="mode-desc">{{ t('message.ultramanDuelView.modeDuelDesc') }}</div>
          </button>
          <button
            class="mode-card"
            :class="{ active: selectedMode === 'solo' }"
            @click="selectedMode = 'solo'"
          >
            <div class="mode-name">{{ t('message.ultramanDuelView.modeSolo') }}</div>
            <div class="mode-desc">{{ t('message.ultramanDuelView.modeSoloDesc') }}</div>
          </button>
          <button
            class="mode-card"
            :class="{ active: selectedMode === 'keyboard' }"
            @click="selectedMode = 'keyboard'"
          >
            <div class="mode-name">{{ t('message.ultramanDuelView.modeKeyboard') }}</div>
            <div class="mode-desc">{{ t('message.ultramanDuelView.modeKeyboardDesc') }}</div>
          </button>
        </div>

        <!-- 双人分位提示 -->
        <div v-if="selectedMode !== 'keyboard'" class="split-hint">
          <span class="split-side p1">{{ t('message.ultramanDuelView.heroP1') }}</span>
          <span class="split-arrow">⇠</span>
          <span class="split-cam">{{ t('message.ultramanDuelView.splitHint') }}</span>
          <span class="split-arrow">⇢</span>
          <span class="split-side p2">{{ t('message.ultramanDuelView.heroP2') }}</span>
        </div>

        <!-- 招式教学 -->
        <div class="moves-grid">
          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="14" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M32 20v18m0 0-9 18m9-18 9 18" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M32 25l-12 4m12-4 17-5" stroke="#facc15" stroke-width="3.5" stroke-linecap="round" />
              <circle cx="51" cy="19" r="4" fill="#facc15" />
            </svg>
            <div class="move-name">{{ t('message.ultramanDuelView.moves.punch') }}</div>
            <div class="move-desc">{{ t('message.ultramanDuelView.moves.punchDesc') }}</div>
          </div>
          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="38" cy="15" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M36 21l-4 17m0 0-8 18m8-18 10 18" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M12 30h12m-12 0 5-5m-5 5 5 5" stroke="#4ade80" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <div class="move-name">{{ t('message.ultramanDuelView.moves.move') }}</div>
            <div class="move-desc">{{ t('message.ultramanDuelView.moves.moveDesc') }}</div>
          </div>
          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="13" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M32 19v20m0 0-8 17m8-17 8 17" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M22 24l20 14M42 24L22 38" stroke="#38bdf8" stroke-width="4" stroke-linecap="round" />
            </svg>
            <div class="move-name">{{ t('message.ultramanDuelView.moves.guard') }}</div>
            <div class="move-desc">{{ t('message.ultramanDuelView.moves.guardDesc') }}</div>
          </div>
          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="26" cy="16" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M26 22v16m0 0-8 16m8-16 8 16" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M30 34l14-6" stroke="#fb923c" stroke-width="4" stroke-linecap="round" />
              <circle cx="48" cy="26" r="4" fill="#fb923c" />
            </svg>
            <div class="move-name">{{ t('message.ultramanDuelView.moves.kick') }}</div>
            <div class="move-desc">{{ t('message.ultramanDuelView.moves.kickDesc') }}</div>
          </div>
          <div class="move-card">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="32" cy="18" r="6" stroke="#38e8ff" stroke-width="3" />
              <path d="M32 24v16m0 0-8 16m8-16 8 16" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M32 27l12-16" stroke="#67e8f9" stroke-width="3.5" stroke-linecap="round" />
              <circle cx="44" cy="9" r="5" stroke="#67e8f9" stroke-width="2.5" stroke-dasharray="3 2" />
            </svg>
            <div class="move-name">{{ t('message.ultramanDuelView.moves.disc') }}</div>
            <div class="move-desc">{{ t('message.ultramanDuelView.moves.discDesc') }}</div>
          </div>
          <div class="move-card highlight">
            <svg class="pose-svg" viewBox="0 0 64 64" fill="none">
              <circle cx="30" cy="14" r="6" stroke="#facc15" stroke-width="3" />
              <path d="M30 20v18m0 0-8 18m8-18 8 18" stroke="#e2e8f0" stroke-width="3" stroke-linecap="round" />
              <path d="M18 32h22M38 18v18" stroke="#38e8ff" stroke-width="4.5" stroke-linecap="round" />
              <circle cx="38" cy="28" r="5" fill="#fef08a" opacity="0.85" />
            </svg>
            <div class="move-name">{{ t('message.ultramanDuelView.moves.beam') }}</div>
            <div class="move-desc">{{ t('message.ultramanDuelView.moves.beamDesc') }}</div>
          </div>
        </div>

        <!-- 键盘模式键位说明 -->
        <div v-if="selectedMode === 'keyboard'" class="keyboard-hints">
          <div class="kb-row p1">
            <span class="kb-tag">P1</span>
            {{ t('message.ultramanDuelView.controls.p1Hint') }}
          </div>
          <div class="kb-row p2">
            <span class="kb-tag">P2</span>
            {{ t('message.ultramanDuelView.controls.p2Hint') }}
          </div>
        </div>

        <!-- 摄像头错误提示：单人模式兜底为键盘单挑 CPU，双人模式兜底为双键盘 -->
        <div v-if="cameraError" class="camera-error-box">
          <div class="error-msg">
            {{ t('message.ultramanDuelView.cameraError') }} {{ cameraError }}
          </div>
          <button
            class="arcade-btn warn"
            @click="handleStartBattle(selectedMode, true)"
          >
            {{
              selectedMode === 'solo'
                ? t('message.ultramanDuelView.switchToKeyboardSolo')
                : t('message.ultramanDuelView.switchToKeyboard')
            }}
          </button>
        </div>

        <button class="transform-btn" :disabled="startingCamera" @click="handleStartBattle()">
          {{
            startingCamera
              ? t('message.ultramanDuelView.loadingModel')
              : t('message.ultramanDuelView.startButton')
          }}
        </button>
      </div>
    </div>

    <!-- 加载中 -->
    <div v-if="hud.phase === 'loading'" class="loading-overlay">
      <div class="loading-card">
        <div class="loading-title">{{ t('message.ultramanDuelView.loadingModel') }}</div>
        <div class="loading-track">
          <div class="loading-fill" :style="{ width: hud.loadingProgress + '%' }" />
        </div>
        <div class="loading-pct">{{ hud.loadingProgress }}%</div>
      </div>
    </div>

    <!-- 对战 HUD -->
    <div v-if="isPlaying" class="battle-hud">
      <div class="hud-top">
        <!-- P1 状态区 -->
        <div class="fighter-panel p1">
          <div class="fighter-name-row">
            <span class="fighter-name">{{ t('message.ultramanDuelView.heroP1') }}</span>
            <span class="source-badge">{{ sourceBadge(0) }}</span>
            <span v-if="hud.combo[0] >= 2" :key="hud.combo[0]" class="combo-pill">
              {{ hud.combo[0] }} {{ t('message.ultramanDuelView.combo') }}
            </span>
          </div>
          <div class="hp-track">
            <div
              class="hp-fill p1"
              :class="{ low: hud.dangerTimer[0] }"
              :style="{ width: hpPercent(0) + '%' }"
            />
          </div>
          <div class="energy-track">
            <div
              class="energy-fill"
              :class="{ ready: hud.energy[0] >= 25, full: hud.energy[0] >= 100 }"
              :style="{ width: hud.energy[0] + '%' }"
            />
          </div>
          <div class="round-pips">
            <span class="pip" :class="{ won: hud.wins[0] >= 1 }" />
            <span class="pip" :class="{ won: hud.wins[0] >= 2 }" />
          </div>
        </div>

        <!-- 中央：回合与倒计时（紧凑单行，不侵入擂台画面） -->
        <div class="hud-center">
          <span class="round-label">{{ t('message.ultramanDuelView.roundLabel') }} {{ hud.round }}</span>
          <span class="round-timer" :class="{ danger: timerDanger }">
            {{ String(hud.roundTimeLeft).padStart(2, '0') }}
          </span>
        </div>

        <!-- P2 状态区（右对齐镜像） -->
        <div class="fighter-panel p2">
          <div class="fighter-name-row">
            <span v-if="hud.combo[1] >= 2" :key="hud.combo[1]" class="combo-pill">
              {{ hud.combo[1] }} {{ t('message.ultramanDuelView.combo') }}
            </span>
            <span class="source-badge">{{ sourceBadge(1) }}</span>
            <span class="fighter-name">{{ t('message.ultramanDuelView.heroP2') }}</span>
          </div>
          <div class="hp-track rtl">
            <div
              class="hp-fill p2"
              :class="{ low: hud.dangerTimer[1] }"
              :style="{ width: hpPercent(1) + '%' }"
            />
          </div>
          <div class="energy-track rtl">
            <div
              class="energy-fill"
              :class="{ ready: hud.energy[1] >= 25, full: hud.energy[1] >= 100 }"
              :style="{ width: hud.energy[1] + '%' }"
            />
          </div>
          <div class="round-pips rtl">
            <span class="pip" :class="{ won: hud.wins[1] >= 1 }" />
            <span class="pip" :class="{ won: hud.wins[1] >= 2 }" />
          </div>
        </div>
      </div>

      <!-- 招式播报大字（贴顶栏下沿，不遮挡角色上身） -->
      <div v-if="hud.activeBannerKey" :key="hud.activeBannerKey" class="skill-banner">
        {{ bannerText }}
      </div>

      <!-- 工具按钮：右上角固定，不占中央擂台画面 -->
      <div v-if="isPlaying" class="hud-tools-fixed">
        <button class="arcade-btn" @click="toggleMute">
          {{ muted ? t('message.ultramanDuelView.mute') : t('message.ultramanDuelView.unmute') }}
        </button>
        <button v-if="isCameraMode" class="arcade-btn" @click="recenterBoth">
          {{ t('message.ultramanDuelView.recenter') }}
        </button>
        <button
          v-if="isCameraMode"
          class="arcade-btn"
          :class="{ active: showSkeleton }"
          @click="showSkeleton = !showSkeleton"
        >
          {{ t('message.ultramanDuelView.skeleton') }}
        </button>
        <button class="arcade-btn danger" @click="handleExitToMenu">
          {{ t('message.ultramanDuelView.stop') }}
        </button>
      </div>

      <!-- 键盘/触屏双操作区 -->
      <div v-if="hud.mode === 'keyboard'" class="dual-pads">
        <div class="pad p1-pad">
          <div class="pad-tag">P1</div>
          <button
            class="pad-btn"
            @pointerdown.prevent="padMove(0, -1)"
            @pointerup="padMove(0, 0)"
            @pointerleave="padMove(0, 0)"
          >
            &lt;
          </button>
          <button
            class="pad-btn"
            @pointerdown.prevent="padMove(0, 1)"
            @pointerup="padMove(0, 0)"
            @pointerleave="padMove(0, 0)"
          >
            &gt;
          </button>
          <button class="pad-btn jump" @click="padJump(0)">
            {{ t('message.ultramanDuelView.controls.jump') }}
          </button>
          <button
            class="pad-btn shield"
            @pointerdown.prevent="padGuard(0, true)"
            @pointerup="padGuard(0, false)"
            @pointerleave="padGuard(0, false)"
          >
            {{ t('message.ultramanDuelView.controls.guard') }}
          </button>
          <button class="pad-btn punch" @click="padPunch(0, 'left')">
            {{ t('message.ultramanDuelView.controls.punchL') }}
          </button>
          <button class="pad-btn punch" @click="padPunch(0, 'right')">
            {{ t('message.ultramanDuelView.controls.punchR') }}
          </button>
          <button class="pad-btn kick" @click="padKick(0)">
            {{ t('message.ultramanDuelView.controls.kick') }}
          </button>
          <button class="pad-btn disc" @click="padDisc(0)">
            {{ t('message.ultramanDuelView.controls.disc') }}
          </button>
          <button
            class="pad-btn beam"
            :class="{ ready: hud.energy[0] >= 60, full: hud.energy[0] >= 100 }"
            @click="padBeam(0)"
          >
            {{ t('message.ultramanDuelView.controls.beam') }}
          </button>
        </div>
        <div class="pad p2-pad">
          <div class="pad-tag">P2</div>
          <button
            class="pad-btn"
            @pointerdown.prevent="padMove(1, -1)"
            @pointerup="padMove(1, 0)"
            @pointerleave="padMove(1, 0)"
          >
            &lt;
          </button>
          <button
            class="pad-btn"
            @pointerdown.prevent="padMove(1, 1)"
            @pointerup="padMove(1, 0)"
            @pointerleave="padMove(1, 0)"
          >
            &gt;
          </button>
          <button class="pad-btn jump" @click="padJump(1)">
            {{ t('message.ultramanDuelView.controls.jump') }}
          </button>
          <button
            class="pad-btn shield"
            @pointerdown.prevent="padGuard(1, true)"
            @pointerup="padGuard(1, false)"
            @pointerleave="padGuard(1, false)"
          >
            {{ t('message.ultramanDuelView.controls.guard') }}
          </button>
          <button class="pad-btn punch" @click="padPunch(1, 'left')">
            {{ t('message.ultramanDuelView.controls.punchL') }}
          </button>
          <button class="pad-btn punch" @click="padPunch(1, 'right')">
            {{ t('message.ultramanDuelView.controls.punchR') }}
          </button>
          <button class="pad-btn kick" @click="padKick(1)">
            {{ t('message.ultramanDuelView.controls.kick') }}
          </button>
          <button class="pad-btn disc" @click="padDisc(1)">
            {{ t('message.ultramanDuelView.controls.disc') }}
          </button>
          <button
            class="pad-btn beam"
            :class="{ ready: hud.energy[1] >= 60, full: hud.energy[1] >= 100 }"
            @click="padBeam(1)"
          >
            {{ t('message.ultramanDuelView.controls.beam') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 赛果结算 -->
    <div v-if="hud.phase === 'match-end'" class="result-overlay">
      <div class="result-card" :class="`p${(hud.winnerSlot ?? 0) + 1}`">
        <h2 class="result-title">{{ winnerText }}</h2>
        <div class="result-stats">
          <div class="stat-box p1">
            <div class="stat-label">{{ t('message.ultramanDuelView.heroP1') }}</div>
            <div class="stat-value">{{ hud.score[0] }}</div>
            <div class="stat-sub">{{ t('message.ultramanDuelView.roundsWon') }} {{ hud.wins[0] }}</div>
          </div>
          <div class="stat-box">
            <div class="stat-label">{{ t('message.ultramanDuelView.score') }}</div>
            <div class="stat-value gold">VS</div>
            <div class="stat-sub">{{ hud.round }} {{ t('message.ultramanDuelView.roundLabel') }}</div>
          </div>
          <div class="stat-box p2">
            <div class="stat-label">{{ t('message.ultramanDuelView.heroP2') }}</div>
            <div class="stat-value">{{ hud.score[1] }}</div>
            <div class="stat-sub">{{ t('message.ultramanDuelView.roundsWon') }} {{ hud.wins[1] }}</div>
          </div>
        </div>
        <div class="result-actions">
          <button class="transform-btn small" @click="handleStartBattle()">
            {{ t('message.ultramanDuelView.rematch') }}
          </button>
          <button class="arcade-btn ghost large" @click="handleGoHome">
            {{ t('message.ultramanDuelView.backHome') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ultraman-duel-page {
  position: fixed;
  inset: 0;
  z-index: 1500;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #070d1f;
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

/* ---- 飘字 ---- */
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
  font-size: 28px;
  font-weight: 900;
  letter-spacing: 1px;
  text-shadow:
    0 3px 0 #000,
    0 0 14px rgba(0, 0, 0, 0.85);
  animation: floatUp 0.95s ease-out forwards;
  white-space: nowrap;
}

.floating-text.p1 {
  color: #7dd3fc;
}

.floating-text.p2 {
  color: #fdba74;
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

/* ---- 双人摄像头 PIP ---- */
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

.pip-rows {
  background: rgba(10, 18, 34, 0.92);
  padding: 4px 6px;
}

.pip-row {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 700;
  padding: 3px 0;
  color: #cbd5e1;
}

.pip-row.p1 .pip-tag {
  color: #38e8ff;
}

.pip-row.p2 .pip-tag {
  color: #fb923c;
}

.pip-tag {
  font-weight: 900;
  flex-shrink: 0;
}

.pip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f97316;
  flex-shrink: 0;
}

.pip-dot.tracked {
  background: #22c55e;
  box-shadow: 0 0 6px #22c55e;
}

.pip-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pip-charge {
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 900;
  background: rgba(255, 255, 255, 0.14);
}

.pip-charge.p1 {
  color: #7dd3fc;
  border: 1px solid rgba(56, 232, 255, 0.6);
}

.pip-charge.p2 {
  color: #fdba74;
  border: 1px solid rgba(251, 146, 60, 0.6);
}

/* ---- 菜单 ---- */
.menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: radial-gradient(circle at 50% 35%, rgba(12, 27, 51, 0.35), rgba(4, 9, 20, 0.85));
}

.menu-card {
  width: min(860px, 95vw);
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
  color: #091325;
  background: linear-gradient(90deg, #38e8ff, #fb923c);
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

.mode-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.mode-card {
  padding: 12px 10px;
  border-radius: 12px;
  border: 2px solid rgba(148, 163, 184, 0.35);
  background: rgba(15, 23, 42, 0.72);
  cursor: pointer;
  transition: all 0.15s;
}

.mode-card.active {
  border-color: #facc15;
  background: rgba(250, 204, 21, 0.14);
}

.mode-name {
  font-size: 15px;
  font-weight: 900;
  color: #f8fafc;
}

.mode-card.active .mode-name {
  color: #fef08a;
}

.mode-desc {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 4px;
}

.split-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 16px;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(30, 41, 59, 0.6);
  border: 1.5px dashed rgba(56, 232, 255, 0.5);
}

.split-side {
  font-size: 13px;
  font-weight: 900;
  padding: 4px 12px;
  border-radius: 999px;
}

.split-side.p1 {
  color: #091325;
  background: linear-gradient(90deg, #38e8ff, #7dd3fc);
}

.split-side.p2 {
  color: #091325;
  background: linear-gradient(90deg, #fb923c, #fdba74);
}

.split-cam {
  font-size: 13px;
  font-weight: 700;
  color: #e2e8f0;
}

.split-arrow {
  color: #64748b;
  font-size: 18px;
}

.moves-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 16px;
}

.move-card {
  padding: 9px 6px;
  border-radius: 12px;
  background: rgba(30, 41, 59, 0.65);
  border: 1.5px solid rgba(148, 163, 184, 0.25);
}

.move-card.highlight {
  border-color: rgba(250, 204, 21, 0.7);
  background: linear-gradient(180deg, rgba(56, 189, 248, 0.18), rgba(250, 204, 21, 0.12));
}

.pose-svg {
  width: 44px;
  height: 44px;
  display: block;
  margin: 0 auto 3px;
}

.move-name {
  font-size: 11px;
  font-weight: 800;
  color: #f8fafc;
}

.move-desc {
  font-size: 10px;
  color: #94a3b8;
  margin-top: 2px;
}

.keyboard-hints {
  margin-bottom: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kb-row {
  font-size: 12px;
  font-weight: 700;
  color: #cbd5e1;
  background: rgba(15, 23, 42, 0.8);
  border-radius: 8px;
  padding: 7px 12px;
  border: 1px solid rgba(148, 163, 184, 0.3);
}

.kb-row.p1 {
  border-color: rgba(56, 232, 255, 0.55);
}

.kb-row.p2 {
  border-color: rgba(251, 146, 60, 0.55);
}

.kb-tag {
  font-weight: 900;
  margin-right: 6px;
}

.kb-row.p1 .kb-tag {
  color: #38e8ff;
}

.kb-row.p2 .kb-tag {
  color: #fb923c;
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

/* ---- 加载 ---- */
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

/* ---- 对战 HUD ---- */
.battle-hud {
  position: fixed;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
}

.hud-top {
  display: grid;
  grid-template-columns: minmax(240px, 1.35fr) minmax(120px, auto) minmax(240px, 1.35fr);
  gap: 14px;
  align-items: start;
}

.fighter-panel {
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: rgba(10, 18, 34, 0.82);
  border-radius: 12px;
  padding: 9px 12px;
  border: 2px solid rgba(56, 232, 255, 0.6);
}

.fighter-panel.p2 {
  border-color: rgba(251, 146, 60, 0.6);
}

.fighter-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.fighter-panel.p2 .fighter-name-row {
  justify-content: flex-end;
}

.fighter-name {
  font-weight: 900;
  letter-spacing: 0.5px;
}

.fighter-panel.p1 .fighter-name {
  color: #7dd3fc;
}

.fighter-panel.p2 .fighter-name {
  color: #fdba74;
}

.source-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  color: #cbd5e1;
  background: rgba(30, 41, 59, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.4);
}

.combo-pill {
  padding: 3px 10px;
  border-radius: 999px;
  background: linear-gradient(90deg, #f97316, #facc15);
  color: #091325;
  font-size: 12px;
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

.hp-track {
  height: 16px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.65);
  border: 1.5px solid rgba(255, 255, 255, 0.25);
  overflow: hidden;
}

.hp-track.rtl {
  direction: rtl;
}

.hp-fill {
  height: 100%;
  transition: width 0.18s ease-out;
}

.hp-fill.p1 {
  background: linear-gradient(90deg, #0284c7, #38e8ff);
  box-shadow: 0 0 12px rgba(56, 232, 255, 0.8);
}

.hp-fill.p2 {
  background: linear-gradient(270deg, #ea580c, #fb923c);
  box-shadow: 0 0 12px rgba(251, 146, 60, 0.8);
}

.hp-fill.low {
  animation: lowBlink 0.55s ease-in-out infinite alternate;
}

@keyframes lowBlink {
  from {
    filter: brightness(1.25);
  }
  to {
    filter: brightness(0.55);
  }
}

.energy-track {
  height: 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}

.energy-track.rtl {
  direction: rtl;
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
  box-shadow: 0 0 10px #facc15;
}

.round-pips {
  display: flex;
  gap: 6px;
}

.round-pips.rtl {
  justify-content: flex-end;
}

.pip {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(250, 204, 21, 0.75);
  background: transparent;
}

.pip.won {
  background: #facc15;
  box-shadow: 0 0 10px rgba(250, 204, 21, 0.9);
}

.hud-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 4px 14px;
  border-radius: 999px;
  background: rgba(10, 18, 34, 0.82);
  border: 1.5px solid rgba(250, 204, 21, 0.45);
  align-self: start;
  margin: 0 auto;
}

.round-label {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #94a3b8;
  white-space: nowrap;
}

.round-timer {
  font-size: 22px;
  font-weight: 900;
  line-height: 1;
  color: #fef08a;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
}

.round-timer.danger {
  color: #fca5a5;
  animation: timerBlink 0.5s ease-in-out infinite alternate;
}

@keyframes timerBlink {
  from {
    opacity: 1;
  }
  to {
    opacity: 0.45;
  }
}

/* 工具按钮：右侧边缘纵排小按钮，不占中央擂台画面 */
.hud-tools-fixed {
  position: fixed;
  top: 118px;
  right: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  z-index: 32;
  pointer-events: auto;
}

.hud-tools-fixed .arcade-btn {
  padding: 5px 9px;
  font-size: 11px;
}

/* 招式播报大字（贴顶栏下沿展示，不遮挡角色上身） */
.skill-banner {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 20px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(14, 116, 144, 0.88), rgba(37, 99, 235, 0.88));
  border: 2px solid #fef08a;
  font-size: clamp(15px, 2vw, 21px);
  font-weight: 900;
  letter-spacing: 2px;
  color: #fef9c3;
  text-shadow: 0 2px 0 #091325;
  box-shadow: 0 0 26px rgba(56, 232, 255, 0.65);
  animation: bannerIn 0.25s ease-out;
  white-space: nowrap;
  z-index: 28;
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

/* ---- 键盘/触屏双操作区 ---- */
.dual-pads {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 14px;
  display: flex;
  justify-content: space-between;
  padding: 0 16px;
  pointer-events: auto;
  gap: 12px;
}

.pad {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  max-width: 49%;
}

.pad-tag {
  font-size: 12px;
  font-weight: 900;
  padding: 4px 8px;
  border-radius: 8px;
  background: rgba(10, 20, 38, 0.85);
}

.p1-pad .pad-tag {
  color: #38e8ff;
  border: 1.5px solid rgba(56, 232, 255, 0.6);
}

.p2-pad .pad-tag {
  color: #fb923c;
  border: 1.5px solid rgba(251, 146, 60, 0.6);
}

.p2-pad {
  justify-content: flex-end;
}

.pad-btn {
  padding: 10px 13px;
  border-radius: 10px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  background: rgba(15, 23, 42, 0.86);
  color: #f8fafc;
  font-size: 12px;
  font-weight: 900;
  cursor: pointer;
  touch-action: none;
}

.pad-btn:active {
  transform: scale(0.95);
}

.pad-btn.jump {
  border-color: #4ade80;
  color: #86efac;
}

.pad-btn.shield {
  border-color: #38bdf8;
  color: #7dd3fc;
}

.pad-btn.punch {
  border-color: #fb923c;
  background: rgba(154, 52, 18, 0.8);
}

.pad-btn.kick {
  border-color: #facc15;
  background: rgba(180, 83, 9, 0.86);
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

/* ---- 结算 ---- */
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
  width: min(560px, 92vw);
  padding: 28px;
  border-radius: 18px;
  background: rgba(10, 20, 38, 0.94);
  border: 2px solid #38e8ff;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.65);
  text-align: center;
}

.result-card.p1 {
  border-color: #38e8ff;
}

.result-card.p2 {
  border-color: #fb923c;
}

.result-title {
  margin: 0 0 20px;
  font-size: 26px;
  font-weight: 900;
  color: #fef08a;
}

.result-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 24px;
}

.stat-box {
  padding: 14px 8px;
  border-radius: 12px;
  background: rgba(30, 41, 59, 0.65);
  border: 1px solid rgba(148, 163, 184, 0.25);
}

.stat-box.p1 {
  border-color: rgba(56, 232, 255, 0.6);
}

.stat-box.p2 {
  border-color: rgba(251, 146, 60, 0.6);
}

.stat-label {
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 22px;
  font-weight: 900;
}

.stat-value.gold {
  color: #fde047;
}

.stat-sub {
  font-size: 11px;
  color: #cbd5e1;
  margin-top: 4px;
}

.result-actions {
  display: flex;
  justify-content: center;
  gap: 14px;
  flex-wrap: wrap;
}

@media (max-width: 900px) {
  .moves-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .mode-grid {
    grid-template-columns: 1fr;
  }
  /* 窄屏：双方血条并排一行，计时器独占下一行居中，中央不再堆叠大块 */
  .hud-top {
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .fighter-panel.p1 {
    order: 1;
  }
  .fighter-panel.p2 {
    order: 2;
  }
  .hud-center {
    order: 3;
    grid-column: 1 / -1;
    margin-top: 2px;
  }
  .fighter-panel.p2 .fighter-name-row {
    justify-content: flex-start;
  }
  .hud-tools-fixed {
    top: 168px;
    right: 8px;
  }
  .dual-pads {
    flex-direction: column;
    align-items: stretch;
  }
  .pad {
    max-width: 100%;
    justify-content: center;
  }
  .p2-pad {
    justify-content: center;
  }
  .camera-pip {
    width: 156px;
    bottom: auto;
    top: 216px;
  }
  .pip-video,
  .pip-skeleton {
    width: 156px;
    height: 117px;
  }
  .skill-banner {
    top: 58px;
    font-size: 15px;
    padding: 5px 14px;
  }
}
</style>
