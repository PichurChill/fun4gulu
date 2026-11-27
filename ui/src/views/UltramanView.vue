<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
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
  GameMode,
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
const SCENE_THEMES: SceneTheme[] = ['auto', 'city', 'seaside', 'mountain', 'volcano']
const CONCRETE_THEMES: ConcreteSceneTheme[] = ['city', 'seaside', 'mountain', 'volcano']
const muted = ref(false)
const showSkeleton = ref(true)
const radarExpanded = ref(false)
const radarMinimized = ref(false)
const showBattleMenu = ref(false)
const showGuide = ref(false)
const camAspect = ref(4 / 3)
const cameraError = ref<string | null>(null)
const startingCamera = ref(false)
const floatingEvents = ref<FloatingDamageEvent[]>([])

// 胜利合影状态（复刻视频 1 00:00 & 00:10-00:11）
const photoCountdown = ref<number | null>(null)
const photoDataUrl = ref<string | null>(null)
const photoFlash = ref(false)
let photoCountdownTimer: number | null = null

const hud = reactive<BattleHudState>({
  phase: 'menu',
  gameMode: 'story',
  battleStage: 'melee',
  controlMode: 'camera',
  loadingProgress: 0,
  calibrationProgress: 0,
  distanceHint: 'ok',
  activeGestureCue: 'none',
  heroId: 'tiga',
  heroForm: 'multi',
  hasForms: true,
  waveIndex: 0,
  totalWaves: MONSTER_WAVES.length,
  activeTheme: 'city',
  monsterState: 'idle',
  monsterId: MONSTER_WAVES[0]!.id,
  monsterHp: MONSTER_WAVES[0]!.maxHp,
  monsterMaxHp: MONSTER_WAVES[0]!.maxHp,
  monsterSpecialHintKey: null,
  heroHp: 100,
  heroMaxHp: 100,
  guardStamina: 100,
  energy: 50,
  score: 0,
  punchChain: 0,
  combo: 0,
  maxCombo: 0,
  perfectGuards: 0,
  perfectDodges: 0,
  defeatedCount: 0,
  warningTextKey: null,
  warningUrgency: 0,
  chargeKind: null,
  chargeProgress: 0,
  discCooldownRatio: 0,
  beamCooldownRatio: 0,
  beamClashActive: false,
  beamClashProgress: 0.5,
  grappleActive: false,
  grappleProgress: 0.48,
  transformProgress: 0,
  finisherReady: false,
  finisherPhase: 'none',
  finisherProgress: 0,
  actionGuide: null,
  activeSkillBannerKey: null,
  impactFlashKind: 'none',
  impactFlashSeq: 0,
  tracking: false,
  bodyCoverage: 'none',
  mirroredCenterX: 0.5,
  poseHintKey: 'hintStandCenter',
  timerDanger: false,
  battleRank: 'A',
  badges: [],
})

const HERO_STATS: Record<HeroId, { atk: number; spd: number; eng: number }> = {
  tiga: { atk: 84, spd: 86, eng: 88 },
  zero: { atk: 95, spd: 92, eng: 80 },
  dyna: { atk: 90, spd: 82, eng: 84 },
  zeta: { atk: 86, spd: 90, eng: 96 },
}

const impactFlashActive = ref<BattleHudState['impactFlashKind']>('none')
let impactFlashTimer: number | null = null
watch(
  () => hud.impactFlashSeq,
  () => {
    if (hud.impactFlashKind === 'none') return
    impactFlashActive.value = hud.impactFlashKind
    if (impactFlashTimer !== null) window.clearTimeout(impactFlashTimer)
    impactFlashTimer = window.setTimeout(() => {
      impactFlashActive.value = 'none'
      impactFlashTimer = null
    }, 220)
  },
)

watch(
  () => hud.phase,
  (p) => {
    poseTracker.setHighIntensityCombat(p === 'fighting')
  },
)

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

const camFrameMode = computed(() => {
  if (selectedMode.value !== 'camera') return 'hidden'
  if (hud.phase === 'calibrating' || hud.phase === 'transform') return 'transform-stage'
  if (hud.phase === 'victory' && !photoDataUrl.value) return 'victory-photo'
  if (isPlaying.value) {
    if (radarMinimized.value) return 'battle-minimized'
    return radarExpanded.value ? 'battle-expanded' : 'battle-compact'
  }
  return 'hidden'
})

const hasCenterActionHud = computed(
  () => hud.beamClashActive || hud.grappleActive || hud.finisherPhase !== 'none',
)

const stageChipText = computed(() => {
  if (hud.gameMode === 'practice') {
    return t('message.ultramanView.practiceBadge')
  }
  if (hud.battleStage === 'ranged' || hud.battleStage === 'transition-ranged') {
    return t('message.ultramanView.stages.ranged')
  }
  if (hud.battleStage === 'grapple' || hud.battleStage === 'grapple-finish') {
    return t('message.ultramanView.stages.grapple')
  }
  if (hud.battleStage === 'finisher-spread' || hud.battleStage === 'finisher-beam') {
    return t('message.ultramanView.stages.finisher')
  }
  return t('message.ultramanView.stages.melee')
})

const actionCoachMeta = computed(() => {
  const g = hud.actionGuide
  if (!g) return null
  const isKey = selectedMode.value === 'keyboard'
  const keyMap = {
    transform: ['transformTitle', isKey ? 'transformKey' : 'transformCam', 'cyan'],
    punch: ['punchTitle', isKey ? 'punchKey' : 'punchCam', 'gold'],
    guard: ['guardTitle', isKey ? 'guardKey' : 'guardCam', 'alert'],
    'dodge-shoot': ['dodgeShootTitle', isKey ? 'dodgeShootKey' : 'dodgeShootCam', 'cyan'],
    'crouch-dodge': ['crouchDodgeTitle', isKey ? 'crouchDodgeKey' : 'crouchDodgeCam', 'alert'],
    'jump-dodge': ['jumpDodgeTitle', isKey ? 'jumpDodgeKey' : 'jumpDodgeCam', 'cyan'],
    grapple: ['grappleTitle', isKey ? 'grappleKey' : 'grappleCam', 'fire'],
    'beam-spread': ['beamSpreadTitle', isKey ? 'beamSpreadKey' : 'beamSpreadCam', 'rainbow'],
    'beam-fire': ['beamFireTitle', isKey ? 'beamFireKey' : 'beamFireCam', 'rainbow'],
    'kick-break': ['kickBreakTitle', isKey ? 'kickBreakKey' : 'kickBreakCam', 'fire'],
    'disc-illusion': ['discIllusionTitle', isKey ? 'discIllusionKey' : 'discIllusionCam', 'cyan'],
  } as const
  const [titleK, descK, tone] = keyMap[g]
  return {
    kind: g,
    title: t(`message.ultramanView.coach.${titleK}`),
    desc: t(`message.ultramanView.coach.${descK}`),
    tone,
  }
})

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
  if (width > 0 && height > 0) {
    camAspect.value = width / height
  }
  const canvas = poseCanvasRef.value
  if (canvas) {
    if (width > 0 && height > 0) {
      const targetW = width >= height ? 320 : 240
      const targetH = Math.max(120, Math.round((targetW * height) / width))
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
      }
    }
    if (!poseCtx) poseCtx = canvas.getContext('2d')
    if (poseCtx) {
      drawTacticalSkeleton(
        poseCtx,
        canvas.width,
        canvas.height,
        [primary?.landmarks],
        showSkeleton.value && hud.phase !== 'victory',
        false,
        [primary?.leftHandLandmarks, primary?.rightHandLandmarks],
        {
          distanceHint: hud.distanceHint,
          activeCue: hud.activeGestureCue,
          chargeProgress: hud.chargeProgress,
        },
      )
    }
  }
  engine?.feedPoseLandmarks(
    primary?.landmarks ?? null,
    primary?.worldLandmarks ?? null,
    now,
    width,
    height,
    undefined,
    primary
      ? {
          left: primary.leftHandLandmarks,
          leftWorld: primary.leftHandWorldLandmarks,
          right: primary.rightHandLandmarks,
          rightWorld: primary.rightHandWorldLandmarks,
        }
      : null,
  )
}

poseTracker.onError = (err) => {
  handleExitToMenu()
  cameraError.value = err instanceof Error ? err.message : String(err)
}

function clearPhotoTimers() {
  if (photoCountdownTimer !== null) {
    window.clearInterval(photoCountdownTimer)
    photoCountdownTimer = null
  }
  photoCountdown.value = null
}

function stopCameraTracking() {
  clearPhotoTimers()
  poseTracker.stop(videoRef.value)
  if (poseCtx && poseCanvasRef.value) {
    poseCtx.clearRect(0, 0, poseCanvasRef.value.width, poseCanvasRef.value.height)
  }
}

// 进入胜利合影阶段时自动开启 3-2-1 拍照倒计时（摄像头模式）
watch(
  () => hud.phase,
  (next) => {
    clearPhotoTimers()
    photoDataUrl.value = null
    showBattleMenu.value = false
    if (next === 'victory' && selectedMode.value === 'camera') {
      startPhotoCountdown()
    } else if (next === 'defeat') {
      if (impactFlashTimer !== null) {
    window.clearTimeout(impactFlashTimer)
    impactFlashTimer = null
  }
  stopCameraTracking()
    }
  },
)

function startPhotoCountdown() {
  clearPhotoTimers()
  photoDataUrl.value = null
  photoCountdown.value = 3
  photoCountdownTimer = window.setInterval(() => {
    if (photoCountdown.value === null) return
    if (photoCountdown.value <= 1) {
      clearPhotoTimers()
      captureVictoryPhoto()
    } else {
      photoCountdown.value -= 1
    }
  }, 1000)
}

/** 合成 3D 英雄星空舞台 + 右侧真人镜像画面 + 光之战士相框纪念照 */
function captureVictoryPhoto() {
  if (!engine) return
  const stageCanvas = engine.getSnapshotCanvas()
  const out = document.createElement('canvas')
  out.width = 1280
  out.height = 720
  const ctx = out.getContext('2d')
  if (!ctx) return

  // 绘制 3D 英雄与星空背景（按等比 cover 居中绘制，防止手机竖屏画布被横向拉扁）
  const sW = stageCanvas.width || out.width
  const sH = stageCanvas.height || out.height
  const sAspect = sW / sH
  const oAspect = out.width / out.height
  let ssx = 0
  let ssy = 0
  let ssw = sW
  let ssh = sH
  if (sAspect > oAspect) {
    ssw = sH * oAspect
    ssx = (sW - ssw) * 0.5
  } else {
    ssh = sW / oAspect
    ssy = (sH - ssh) * 0.5
  }
  ctx.drawImage(stageCanvas, ssx, ssy, ssw, ssh, 0, 0, out.width, out.height)

  // 若摄像头在线，把玩家镜像画面合成至右侧发光光框（复刻视频 1 00:00 合影）
  const video = videoRef.value
  if (selectedMode.value === 'camera' && video && video.readyState >= 2 && video.videoWidth > 0) {
    const boxW = 460
    const boxH = 520
    const boxX = out.width - boxW - 76
    const boxY = (out.height - boxH) * 0.5
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxW, boxH, 24)
    ctx.clip()

    const vAspect = video.videoWidth / video.videoHeight
    const bAspect = boxW / boxH
    let sx = 0
    let sy = 0
    let sw = video.videoWidth
    let sh = video.videoHeight
    if (vAspect > bAspect) {
      sw = video.videoHeight * bAspect
      sx = (video.videoWidth - sw) * 0.5
    } else {
      sh = video.videoWidth / bAspect
      sy = (video.videoHeight - sh) * 0.5
    }
    ctx.translate(boxX + boxW, boxY)
    ctx.scale(-1, 1)
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, boxW, boxH)
    ctx.restore()

    ctx.strokeStyle = '#38e8ff'
    ctx.lineWidth = 6
    ctx.shadowColor = '#38e8ff'
    ctx.shadowBlur = 22
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxW, boxH, 24)
    ctx.stroke()
    ctx.shadowBlur = 0
  }

  // 外框星芒角标与战绩水印
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)'
  ctx.lineWidth = 5
  ctx.strokeRect(18, 18, out.width - 36, out.height - 36)

  ctx.fillStyle = 'rgba(5, 13, 28, 0.78)'
  ctx.fillRect(36, out.height - 86, 560, 52)
  ctx.fillStyle = '#fef08a'
  ctx.font = 'italic 900 24px sans-serif'
  ctx.fillText(
    `${t(`message.ultramanView.heroNames.${hud.heroId}`)} · RANK ${hud.battleRank} · SCORE ${hud.score} · MAX ${hud.maxCombo} COMBO`,
    52,
    out.height - 52,
  )

  photoDataUrl.value = out.toDataURL('image/png')
  engine.audio.playShutter()
  photoFlash.value = true
  window.setTimeout(() => {
    photoFlash.value = false
  }, 260)
}

function downloadVictoryPhoto() {
  if (!photoDataUrl.value) captureVictoryPhoto()
  if (!photoDataUrl.value) return
  const link = document.createElement('a')
  link.href = photoDataUrl.value
  link.download = `ultraman-${hud.heroId}-victory.png`
  link.click()
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
async function handleStartBattle(overrideMode?: ControlMode, gameMode: GameMode = 'story') {
  if (!engine || startingCamera.value) return
  if (overrideMode) {
    selectedMode.value = overrideMode
    engine.setControlMode(overrideMode)
  }
  cameraError.value = null
  showGuide.value = false
  photoDataUrl.value = null
  engine.audio.unlock()

  if (impactFlashTimer !== null) {
    window.clearTimeout(impactFlashTimer)
    impactFlashTimer = null
  }
  stopCameraTracking()

  if (selectedMode.value === 'camera') {
    startingCamera.value = true
    try {
      await poseTracker.start(videoRef.value!, 1)
    } catch (err: unknown) {
      if (impactFlashTimer !== null) {
    window.clearTimeout(impactFlashTimer)
    impactFlashTimer = null
  }
  stopCameraTracking()
      startingCamera.value = false
      cameraError.value = err instanceof Error ? err.message : String(err)
      return
    }
    startingCamera.value = false
  }

  await engine.startGame(selectedMode.value, selectedWave.value, selectedTheme.value, gameMode)
}

function handleSkipCalibration() {
  engine?.skipCalibration()
}

function handleTriggerFinisher() {
  engine?.triggerManualFinisher()
}

function handleExitToMenu() {
  showBattleMenu.value = false
  if (impactFlashTimer !== null) {
    window.clearTimeout(impactFlashTimer)
    impactFlashTimer = null
  }
  stopCameraTracking()
  pressedKeys.clear()
  engine?.setManualLean(0)
  engine?.setManualGuard(false)
  engine?.setManualSpread(false)
  engine?.stopToMenu()
}

function handleGoHome() {
  if (impactFlashTimer !== null) {
    window.clearTimeout(impactFlashTimer)
    impactFlashTimer = null
  }
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

function handleSkipTransform() {
  engine?.triggerManualTransform()
}

// ---- 键盘控制 ----
function updateManualLeanFromKeys() {
  const left = pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft')
  const right = pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight')
  const dir: -1 | 0 | 1 = left && !right ? -1 : right && !left ? 1 : 0
  engine?.setManualLean(dir)
}

function onKeyDown(e: KeyboardEvent) {
  if (!engine) return
  if (hud.phase === 'calibrating') {
    if (['Space', 'Enter'].includes(e.code)) {
      e.preventDefault()
      engine.skipCalibration()
    }
    return
  }
  if (hud.phase === 'transform') {
    if (['Space', 'Enter', 'KeyJ', 'KeyK'].includes(e.code)) {
      e.preventDefault()
      engine.triggerManualTransform()
    }
    return
  }
  if (hud.phase !== 'fighting') return
  if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'].includes(e.code)) {
    e.preventDefault()
  }
  pressedKeys.add(e.code)
  updateManualLeanFromKeys()

  if (hud.finisherPhase === 'spread' && (e.code === 'Space' || e.code === 'KeyL')) {
    engine.setManualSpread(true)
    return
  }

  if (
    e.code === 'KeyS' ||
    e.code === 'ArrowDown' ||
    e.code === 'ShiftLeft' ||
    e.code === 'ShiftRight'
  ) {
    engine.setManualGuard(true)
    return
  }
  if (e.code === 'KeyC') {
    engine.setManualCrouch(true)
    return
  }
  if (e.repeat) return

  if (e.code === 'KeyW' || e.code === 'ArrowUp') {
    engine.triggerManualJump()
  } else if (e.code === 'KeyJ' || e.code === 'KeyZ') {
    engine.triggerManualPunch('left')
  } else if (e.code === 'KeyK' || e.code === 'KeyX') {
    engine.triggerManualPunch('right')
  } else if (e.code === 'KeyI') {
    engine.triggerManualKick('right')
  } else if (e.code === 'KeyU') {
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
  if (e.code === 'Space' || e.code === 'KeyL') {
    engine?.setManualSpread(false)
  }
  if (e.code === 'KeyC') {
    engine?.setManualCrouch(false)
  }
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
  engine?.setManualCrouch(false)
  engine?.setManualSpread(false)
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
function onTouchCrouch(active: boolean) {
  engine?.setManualCrouch(active)
}
function onTouchJump() {
  engine?.triggerManualJump()
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
function onTouchBeamDown() {
  if (hud.finisherPhase === 'spread') {
    engine?.setManualSpread(true)
  }
  engine?.triggerManualBeam()
}
function onTouchBeamUp() {
  engine?.setManualSpread(false)
}
function onTouchCenterHudDown() {
  if (hud.grappleActive || hud.beamClashActive) {
    engine?.triggerManualPunch('right')
  } else if (hud.finisherPhase === 'spread') {
    engine?.setManualSpread(true)
    engine?.triggerManualBeam()
  } else if (hud.finisherPhase === 'beam') {
    engine?.triggerManualBeam()
  }
}
function onTouchCenterHudUp() {
  engine?.setManualSpread(false)
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
  if (impactFlashTimer !== null) {
    window.clearTimeout(impactFlashTimer)
    impactFlashTimer = null
  }
  stopCameraTracking()
  engine?.dispose()
  engine = null
})
</script>

<template>
  <div class="ultra-cockpit" :style="{ '--hero-accent': activeHeroHex }">
    <!-- 3D 实景特摄战场全屏画布 -->
    <div ref="stageRef" class="stage-canvas-wrap" />

    <!-- 拍照闪光幕 -->
    <div v-if="photoFlash" class="shutter-flash" />

    <!-- 全屏战斗视觉冲击帧层（重击/弹反/子弹时间闪避/受击边缘光晕） -->
    <div
      v-if="impactFlashActive !== 'none'"
      :key="hud.impactFlashSeq"
      class="impact-screen-fx"
      :class="impactFlashActive"
      aria-hidden="true"
    />

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

    <!-- 统一实时摄像头窗（随阶段平滑变形：变身光阵同框 / 战斗左下动捕雷达 / 胜利右侧双人合影窗） -->
    <div class="live-cam-frame" :class="camFrameMode">
      <div v-if="isPlaying" class="radar-header">
        <span class="radar-badge" :class="hud.bodyCoverage">
          {{
            hud.bodyCoverage === 'full'
              ? t('message.ultramanView.bodySyncFull')
              : hud.bodyCoverage === 'upper'
                ? t('message.ultramanView.bodySyncUpper')
                : t('message.ultramanView.bodySyncNone')
          }}
        </span>
        <div class="radar-header-actions">
          <button
            v-if="!radarMinimized"
            type="button"
            class="radar-zoom-btn"
            @click="radarExpanded = !radarExpanded"
          >
            {{ radarExpanded ? '−' : '+' }}
          </button>
          <button
            type="button"
            class="radar-zoom-btn"
            @click="radarMinimized = !radarMinimized"
          >
            {{ radarMinimized ? '▲' : '▼' }}
          </button>
        </div>
      </div>
      <div
        class="radar-viewport"
        :class="{ collapsed: isPlaying && radarMinimized }"
        :style="isPlaying && !radarMinimized ? { aspectRatio: String(camAspect) } : undefined"
      >
        <video ref="videoRef" autoplay playsinline muted class="radar-video" />
        <canvas ref="poseCanvasRef" width="320" height="240" class="radar-skeleton" />
        <div v-if="hud.phase === 'victory' && photoCountdown !== null" class="photo-countdown-num">
          {{ photoCountdown }}
        </div>
      </div>
      <div v-if="isPlaying && !radarMinimized" class="radar-footer" :class="{ tracked: hud.tracking }">
        <span class="radar-dot" />
        <span class="radar-hint">{{ t(`message.ultramanView.hints.${hud.poseHintKey}`) }}</span>
      </div>
      <div v-if="isPlaying && hud.chargeKind && hud.chargeProgress > 0.05" class="radar-charge-track">
        <div
          class="radar-charge-fill"
          :class="hud.chargeKind"
          :style="{ width: Math.round(hud.chargeProgress * 100) + '%' }"
        />
      </div>
    </div>

    <!-- ================= 开场站位校准浮层（可随时跳过） ================= -->
    <div v-if="hud.phase === 'calibrating'" class="transform-overlay">
      <div class="transform-guide-card calibrate-card">
        <div class="distance-pill" :class="hud.distanceHint">
          {{ t(`message.ultramanView.distanceHints.${hud.distanceHint}`) }}
        </div>
        <div class="transform-guide-title">{{ t('message.ultramanView.calibrateTitle') }}</div>
        <div class="transform-guide-desc">{{ t('message.ultramanView.calibrateDesc') }}</div>
        <div class="transform-bar-bg">
          <div
            class="transform-bar-fg"
            :style="{ width: Math.round(hud.calibrationProgress * 100) + '%' }"
          />
        </div>
        <button type="button" class="sortie-cta compact" @click="handleSkipCalibration">
          <span class="sortie-cta-label">{{ t('message.ultramanView.calibrateSkip') }}</span>
        </button>
      </div>
    </div>

    <!-- ================= 幕 0：宇宙星海体感变身仪式 ================= -->
    <div v-if="hud.phase === 'transform'" class="transform-overlay">
      <div class="transform-guide-card">
        <svg class="silhouette-svg transform-pose" viewBox="0 0 120 170" aria-hidden="true">
          <circle cx="60" cy="34" r="13" />
          <path d="M52 50 L68 50 L74 96 L46 96 Z" />
          <!-- 右手高举过头顶 -->
          <path class="glow-limb" d="M68 54 L80 28 L86 8" stroke-width="11" stroke-linecap="round" fill="none" />
          <circle class="spark-dot" cx="86" cy="8" r="8" />
          <!-- 左手收腰 -->
          <path d="M52 56 L36 78 L42 96" stroke-width="10" stroke-linecap="round" fill="none" />
          <!-- 双腿稳立 -->
          <path d="M53 96 L44 156 M67 96 L76 156" stroke-width="12" stroke-linecap="round" fill="none" />
        </svg>
        <div class="transform-guide-title">{{ t('message.ultramanView.coach.transformTitle') }}</div>
        <div class="transform-guide-desc">
          {{
            selectedMode === 'camera'
              ? t('message.ultramanView.coach.transformCam')
              : t('message.ultramanView.coach.transformKey')
          }}
        </div>
        <div class="transform-bar-bg">
          <div
            class="transform-bar-fg"
            :style="{ width: Math.round(hud.transformProgress * 100) + '%' }"
          />
        </div>
        <button type="button" class="sortie-cta compact" @click="handleSkipTransform">
          <span class="sortie-cta-label">{{ t('message.ultramanView.coach.transformSkip') }}</span>
        </button>
      </div>
    </div>

    <!-- ================= 机库整备主界面（舞台优先 · 零中央遮挡） ================= -->
    <div v-if="hud.phase === 'menu'" class="hangar-shell">
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
          <button type="button" class="tac-btn accent icon-btn" @click="router.push('/ultraman/split')">
            <svg class="ui-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5L21 6V3h-3L6.5 14.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>{{ t('message.ultramanView.split') }}</span>
          </button>
          <UltraSoundtrack inline :playing="false" :muted="muted" />
          <button type="button" class="tac-btn" @click="toggleMute">
            {{ muted ? t('message.ultramanView.mute') : t('message.ultramanView.unmute') }}
          </button>
        </div>
      </header>

      <div class="hangar-body">
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
                <div class="hero-stat-bars">
                  <span class="stat-seg"><i :style="{ width: HERO_STATS[id].atk + '%' }" /></span>
                  <span class="stat-seg spd"><i :style="{ width: HERO_STATS[id].spd + '%' }" /></span>
                  <span class="stat-seg eng"><i :style="{ width: HERO_STATS[id].eng + '%' }" /></span>
                </div>
              </div>
            </button>
          </div>
        </aside>

        <div class="stage-pedestal-hud">
          <div class="pedestal-plate">
            <span class="pedestal-code">{{ selectedHero.toUpperCase() }}</span>
            <strong class="pedestal-name">{{ t(`message.ultramanView.heroNames.${selectedHero}`) }}</strong>
            <span v-if="hud.hasForms" class="form-pill" :class="hud.heroForm">
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

        <aside class="hangar-wing right-wing">
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

          <div class="cta-stack">
            <button
              type="button"
              class="sortie-cta"
              :disabled="startingCamera"
              @click="handleStartBattle(undefined, 'story')"
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
            <button
              type="button"
              class="practice-cta"
              :disabled="startingCamera"
              @click="handleStartBattle(undefined, 'practice')"
            >
              <svg class="ui-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="4" />
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3" stroke-linecap="round" />
              </svg>
              <span>{{ t('message.ultramanView.practiceButton') }}</span>
            </button>
          </div>
        </aside>
      </div>

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

    <!-- ================= 实战悦动元气机大屏极简影视 HUD ================= -->
    <div v-if="isPlaying" class="battle-hud">
      <!-- 顶部三栏：左上精简分值与阶段徽章 / 正中细长锐利红色 Boss 血条 / 右上紧凑工具 -->
      <div class="hud-top">
        <div class="hud-top-left">
          <div class="score-plate">
            <span class="plate-label">{{ t('message.ultramanView.score') }}</span>
            <span class="plate-value">{{ hud.score }}</span>
          </div>
          <span class="stage-pill">{{ stageChipText }}</span>
        </div>

        <!-- 顶部防卫队分段 Boss 血条 + 机制破局实时提示 -->
        <div class="boss-slim-hud">
          <div class="boss-slim-meta">
            <span class="boss-wave-tag">
              {{ t('message.ultramanView.wave', { current: hud.waveIndex + 1, total: hud.totalWaves }) }}
            </span>
            <span
              v-if="
                hud.phase === 'fighting' &&
                ['guarding', 'staggered', 'roaring', 'recovering', 'illusion', 'absorbing', 'stunned'].includes(hud.monsterState)
              "
              class="boss-state-chip"
              :class="hud.monsterState"
            >
              {{ t(`message.ultramanView.reactions.${hud.monsterState}`) }}
            </span>
            <strong class="boss-title">{{ currentMonsterName }}</strong>
          </div>
          <div class="slim-bar-track segmented">
            <div class="slim-bar-trail" :style="{ width: monsterHpPercent + '%' }" />
            <div class="slim-bar-fill" :style="{ width: monsterHpPercent + '%' }" />
            <div class="hp-seg-ticks" aria-hidden="true">
              <span /><span /><span />
            </div>
          </div>
          <div v-if="hud.monsterSpecialHintKey" class="special-tactic-banner">
            {{ t(`message.ultramanView.specialHints.${hud.monsterSpecialHintKey}`) }}
          </div>
        </div>

        <div class="hud-top-right">
          <div class="battle-menu-wrap">
            <button
              type="button"
              class="tac-btn icon-btn"
              :class="{ active: showBattleMenu }"
              @click="showBattleMenu = !showBattleMenu"
            >
              <svg class="ui-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.66 0-1.25.4-1.51 1z" />
              </svg>
              <span>{{ t('message.ultramanView.settings') }}</span>
            </button>
            <div v-show="showBattleMenu" class="battle-menu-popover">
              <button type="button" class="menu-item-btn" @click="cycleActiveArena">
                <span class="inline-svg-label">
                  <svg class="ui-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
                  </svg>
                  {{ t('message.ultramanView.selectArena') }}
                </span>
                <strong>{{ t(`message.ultramanView.arenas.${hud.activeTheme}`) }}</strong>
              </button>
              <div class="menu-item-row">
                <UltraSoundtrack inline :playing="isPlaying" :muted="muted" />
                <button type="button" class="tac-btn compact-btn" @click="toggleMute">
                  {{ muted ? t('message.ultramanView.mute') : t('message.ultramanView.unmute') }}
                </button>
              </div>
              <button
                v-if="selectedMode === 'camera'"
                type="button"
                class="menu-item-btn"
                @click="handleRecenter"
              >
                <span class="inline-svg-label">
                  <svg class="ui-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="8" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                  {{ t('message.ultramanView.recenter') }}
                </span>
              </button>
              <button
                v-if="selectedMode === 'camera'"
                type="button"
                class="menu-item-btn"
                :class="{ active: showSkeleton }"
                @click="showSkeleton = !showSkeleton"
              >
                <span class="inline-svg-label">
                  <svg class="ui-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                  </svg>
                  {{ t('message.ultramanView.skeleton') }}
                </span>
                <strong>{{ showSkeleton ? 'ON' : 'OFF' }}</strong>
              </button>
            </div>
          </div>
          <button type="button" class="tac-btn danger" @click="handleExitToMenu">
            {{ t('message.ultramanView.stop') }}
          </button>
        </div>
      </div>

      <!-- 画面右侧超大发光动态连击数（复刻视频 2 电视右侧标志性“13 连击”视觉！） -->
      <div v-if="hud.combo >= 2" :key="hud.combo" class="stage-combo-burst">
        <span class="stage-combo-num">{{ hud.combo }}</span>
        <span class="stage-combo-label">{{ t('message.ultramanView.combo') }}</span>
      </div>

      <!-- 中部弹性悬停舱：让对波 / 角力 / 终结光线引导条始终居于顶部与底部栏之间，任意宽高比 100% 物理零重叠 -->
      <div class="hud-mid-dock">
        <!-- 宿命双光线对波拔河仪 -->
        <div
          v-if="hud.beamClashActive"
          class="clash-hud interactive-hud"
          @pointerdown.prevent="onTouchCenterHudDown"
        >
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

        <!-- 幕 3：近身角力红蓝推力对抗条（内嵌动作示范，手机端可直接连点进度条发力） -->
        <div
          v-else-if="hud.grappleActive"
          class="grapple-hud interactive-hud"
          @pointerdown.prevent="onTouchCenterHudDown"
        >
          <svg class="coach-icon inline-icon" viewBox="0 0 80 80" aria-hidden="true">
            <circle cx="40" cy="18" r="7" />
            <line x1="40" y1="26" x2="40" y2="50" stroke-width="6" stroke-linecap="round" />
            <line x1="40" y1="50" x2="29" y2="72" stroke-width="6" stroke-linecap="round" />
            <line x1="40" y1="50" x2="51" y2="72" stroke-width="6" stroke-linecap="round" />
            <line class="accent-limb" x1="40" y1="33" x2="68" y2="28" stroke-width="6" stroke-linecap="round" />
            <line class="accent-limb" x1="40" y1="39" x2="68" y2="42" stroke-width="6" stroke-linecap="round" />
          </svg>
          <div class="center-hud-body">
            <div class="grapple-title">
              {{ t('message.ultramanView.coach.grappleTitle') }}
            </div>
            <div class="grapple-track">
              <div
                class="grapple-hero-fill"
                :style="{ width: Math.round(hud.grappleProgress * 100) + '%' }"
              />
              <div
                class="grapple-spark"
                :style="{ left: Math.round(hud.grappleProgress * 100) + '%' }"
              />
            </div>
            <div class="grapple-sub">
              {{
                selectedMode === 'camera'
                  ? t('message.ultramanView.coach.grappleCam')
                  : t('message.ultramanView.coach.grappleKey')
              }}
            </div>
          </div>
        </div>

        <!-- 幕 4：二段终结必杀光线红金特写条（手机端可直接按住蓄力 / 点击发射） -->
        <div
          v-else-if="hud.finisherPhase !== 'none'"
          class="finisher-bar-hud interactive-hud"
          @pointerdown.prevent="onTouchCenterHudDown"
          @pointerup="onTouchCenterHudUp"
          @pointerleave="onTouchCenterHudUp"
          @pointercancel="onTouchCenterHudUp"
        >
          <svg class="coach-icon inline-icon" viewBox="0 0 80 80" aria-hidden="true">
            <circle cx="40" cy="18" r="7" />
            <line x1="40" y1="26" x2="40" y2="50" stroke-width="6" stroke-linecap="round" />
            <line x1="40" y1="50" x2="29" y2="72" stroke-width="6" stroke-linecap="round" />
            <line x1="40" y1="50" x2="51" y2="72" stroke-width="6" stroke-linecap="round" />
            <template v-if="hud.finisherPhase === 'spread'">
              <line class="accent-limb" x1="8" y1="34" x2="72" y2="34" stroke-width="6" stroke-linecap="round" />
            </template>
            <template v-else>
              <line class="accent-limb" x1="20" y1="38" x2="52" y2="38" stroke-width="6" stroke-linecap="round" />
              <line class="accent-limb" x1="48" y1="16" x2="48" y2="46" stroke-width="6" stroke-linecap="round" />
            </template>
          </svg>
          <div class="center-hud-body">
            <div class="finisher-headline">
              {{
                hud.finisherPhase === 'spread'
                  ? t('message.ultramanView.coach.beamSpreadTitle')
                  : t('message.ultramanView.coach.beamFireTitle')
              }}
            </div>
            <div class="finisher-progress-track">
              <div
                class="finisher-progress-fill"
                :style="{ width: Math.round(hud.finisherProgress * 100) + '%' }"
              />
            </div>
            <div class="finisher-sub">
              {{
                hud.finisherPhase === 'spread'
                  ? selectedMode === 'camera'
                    ? t('message.ultramanView.coach.beamSpreadCam')
                    : t('message.ultramanView.coach.beamSpreadKey')
                  : selectedMode === 'camera'
                    ? t('message.ultramanView.coach.beamFireCam')
                    : t('message.ultramanView.coach.beamFireKey')
              }}
            </div>
          </div>
        </div>
        <!-- 主动终结光线就绪光带（怪兽残血或眩晕时浮现，展臂或一键释放终结绝杀） -->
        <button
          v-else-if="hud.finisherReady"
          type="button"
          class="finisher-ready-cta"
          @pointerdown.prevent="handleTriggerFinisher"
        >
          <svg class="ui-svg bolt-svg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13 2L4 14h7l-1 8 10-12h-7l0-8z" />
          </svg>
          <span>{{ t('message.ultramanView.finisherReadyBtn') }}</span>
        </button>
      </div>
      <div v-if="!hasCenterActionHud && hud.warningTextKey" class="hazard-banner">
        <div class="hazard-text">{{ warningMessage }}</div>
        <div class="hazard-progress-bg">
          <div
            class="hazard-progress-fg"
            :style="{ width: Math.round(hud.warningUrgency * 100) + '%' }"
          />
        </div>
      </div>

      <!-- 特摄大字招式播报（角力/终结技专属条激活时自动避让，避免同屏重复文案遮挡特写） -->
      <div
        v-if="hud.activeSkillBannerKey && !hasCenterActionHud"
        :key="hud.activeSkillBannerKey"
        class="cutin-banner"
        :class="{ shifted: !!hud.warningTextKey }"
      >
        {{ t(`message.ultramanView.banners.${hud.activeSkillBannerKey}`) }}
      </div>

      <!-- 底部区域：左下紧凑计时器装甲仪 + 右下动态动作教学引导卡（/键盘操控台） -->
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

            <div class="shield-stamina-row">
              <span class="shield-stamina-label">{{ t('message.ultramanView.guardStamina') }}</span>
              <div class="shield-stamina-track">
                <div
                  class="shield-stamina-fill"
                  :class="{ low: hud.guardStamina < 28 }"
                  :style="{ width: hud.guardStamina + '%' }"
                />
              </div>
            </div>
          </div>
        </div>

        <div class="bottom-right-cluster">
          <!-- 右下角防卫队动态关节示范指令卡 -->
          <div v-if="actionCoachMeta && !hasCenterActionHud" class="action-coach-card" :class="actionCoachMeta.tone">
            <svg class="coach-icon" :class="'anim-' + actionCoachMeta.kind" viewBox="0 0 80 80" aria-hidden="true">
              <g class="coach-body-rig">
                <circle cx="40" cy="18" r="7" />
                <line x1="40" y1="26" x2="40" y2="50" stroke-width="6" stroke-linecap="round" />
                <line x1="40" y1="50" x2="29" y2="72" stroke-width="6" stroke-linecap="round" />
                <line x1="40" y1="50" x2="51" y2="72" stroke-width="6" stroke-linecap="round" />
                <template v-if="actionCoachMeta.kind === 'guard'">
                  <line class="accent-limb" x1="25" y1="30" x2="54" y2="48" stroke-width="6" stroke-linecap="round" />
                  <line class="accent-limb" x1="55" y1="30" x2="26" y2="48" stroke-width="6" stroke-linecap="round" />
                </template>
                <template v-else-if="actionCoachMeta.kind === 'crouch-dodge'">
                  <line class="accent-limb" x1="24" y1="36" x2="56" y2="36" stroke-width="6" stroke-linecap="round" />
                  <path class="arrow-hint" d="M40 6 L34 15 L46 15 Z" transform="rotate(180 40 10)" />
                </template>
                <template v-else-if="actionCoachMeta.kind === 'jump-dodge'">
                  <line class="accent-limb" x1="22" y1="26" x2="58" y2="26" stroke-width="6" stroke-linecap="round" />
                  <path class="arrow-hint" d="M40 2 L33 12 L47 12 Z" />
                </template>
                <template v-else-if="actionCoachMeta.kind === 'disc-illusion'">
                  <line class="accent-limb" x1="40" y1="32" x2="62" y2="12" stroke-width="6" stroke-linecap="round" />
                  <circle class="accent-limb" cx="62" cy="12" r="6" fill="none" stroke-width="3" />
                </template>
                <template v-else-if="actionCoachMeta.kind === 'beam-spread'">
                  <line class="accent-limb" x1="8" y1="34" x2="72" y2="34" stroke-width="6" stroke-linecap="round" />
                </template>
                <template v-else-if="actionCoachMeta.kind === 'beam-fire'">
                  <line class="accent-limb" x1="20" y1="38" x2="52" y2="38" stroke-width="6" stroke-linecap="round" />
                  <line class="accent-limb" x1="48" y1="16" x2="48" y2="46" stroke-width="6" stroke-linecap="round" />
                </template>
                <template v-else-if="actionCoachMeta.kind === 'dodge-shoot'">
                  <line class="accent-limb" x1="16" y1="36" x2="64" y2="28" stroke-width="6" stroke-linecap="round" />
                  <path class="arrow-hint" d="M8 62 L20 56 L20 68 Z M72 62 L60 56 L60 68 Z" />
                </template>
                <template v-else-if="actionCoachMeta.kind === 'grapple'">
                  <line class="accent-limb" x1="40" y1="33" x2="68" y2="28" stroke-width="6" stroke-linecap="round" />
                  <line class="accent-limb" x1="40" y1="39" x2="68" y2="42" stroke-width="6" stroke-linecap="round" />
                </template>
                <template v-else>
                  <line class="accent-limb" x1="40" y1="34" x2="66" y2="24" stroke-width="6" stroke-linecap="round" />
                  <line x1="40" y1="34" x2="20" y2="42" stroke-width="6" stroke-linecap="round" />
                </template>
              </g>
            </svg>
            <div class="coach-copy">
              <div class="coach-title">{{ actionCoachMeta.title }}</div>
              <div class="coach-desc">{{ actionCoachMeta.desc }}</div>
            </div>
          </div>

          <!-- 键盘 / 触屏双组人体工学街机按键甲板（含深蹲闪/起跳闪） -->
          <div v-if="selectedMode === 'keyboard'" class="arcade-deck">
            <div class="deck-group movement-pad">
              <div class="move-row">
                <button
                  type="button"
                  class="deck-btn"
                  @pointerdown.prevent="onTouchJump"
                >
                  <kbd>W</kbd>
                  <span>{{ t('message.ultramanView.controls.jump') }}</span>
                </button>
                <button
                  type="button"
                  class="deck-btn"
                  @pointerdown.prevent="onTouchCrouch(true)"
                  @pointerup="onTouchCrouch(false)"
                  @pointerleave="onTouchCrouch(false)"
                  @pointercancel="onTouchCrouch(false)"
                >
                  <kbd>C</kbd>
                  <span>{{ t('message.ultramanView.controls.crouch') }}</span>
                </button>
              </div>
              <div class="move-row">
                <button
                  type="button"
                  class="deck-btn"
                  @pointerdown.prevent="onTouchLean(-1)"
                  @pointerup="onTouchLean(0)"
                  @pointerleave="onTouchLean(0)"
                  @pointercancel="onTouchLean(0)"
                >
                  <kbd>A</kbd>
                  <span>{{ t('message.ultramanView.controls.left') }}</span>
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
                  <span>{{ t('message.ultramanView.controls.guard') }}</span>
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
                  <span>{{ t('message.ultramanView.controls.right') }}</span>
                </button>
              </div>
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
                  :class="{ ready: hud.energy >= 35 || hud.finisherReady || hud.finisherPhase !== 'none', full: hud.energy >= 100 || hud.finisherReady || hud.finisherPhase !== 'none' }"
                  @pointerdown.prevent="onTouchBeamDown"
                  @pointerup="onTouchBeamUp"
                  @pointerleave="onTouchBeamUp"
                  @pointercancel="onTouchBeamUp"
                >
                  <div
                    v-if="hud.beamCooldownRatio > 0.02"
                    class="cd-veil"
                    :style="{ height: Math.round(hud.beamCooldownRatio * 100) + '%' }"
                  />
                  <kbd>SPACE</kbd>
                  <span>{{ t('message.ultramanView.controls.beam') }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 幕 5：胜利星海合影 & S/A/B/C 战评勋章 ================= -->
    <div v-if="hud.phase === 'victory'" class="victory-photo-shell">
      <div class="victory-top-bar">
        <div class="victory-rank-cluster">
          <span class="rank-stamp" :class="'rank-' + hud.battleRank">{{ hud.battleRank }}</span>
          <div class="victory-badge">{{ t('message.ultramanView.photo.title') }}</div>
        </div>
        <div class="victory-stats-strip">
          <span>{{ t('message.ultramanView.result.totalScore') }} <strong>{{ hud.score }}</strong></span>
          <span>{{ t('message.ultramanView.result.maxCombo') }} <strong>{{ hud.maxCombo }}</strong></span>
          <span>{{ t('message.ultramanView.result.perfectGuards') }} <strong>{{ hud.perfectGuards }}</strong></span>
          <span>{{ t('message.ultramanView.result.perfectDodges') }} <strong>{{ hud.perfectDodges }}</strong></span>
        </div>
        <div v-if="hud.badges.length > 0" class="victory-badge-strip">
          <span v-for="b in hud.badges" :key="b" class="honor-chip">
            {{ t(`message.ultramanView.result.badges.${b}`) }}
          </span>
        </div>
      </div>

      <div v-if="photoDataUrl" class="photo-preview-card">
        <img :src="photoDataUrl" alt="Victory Photo" class="photo-preview-img" />
      </div>

      <div class="victory-bottom-actions">
        <button
          v-if="!photoDataUrl"
          type="button"
          class="sortie-cta compact"
          @click="captureVictoryPhoto"
        >
          <span class="sortie-cta-label">{{ t('message.ultramanView.photo.snapNow') }}</span>
        </button>
        <template v-else>
          <button
            type="button"
            class="tac-btn large"
            @click="selectedMode === 'camera' ? startPhotoCountdown() : (photoDataUrl = null)"
          >
            {{ t('message.ultramanView.photo.retake') }}
          </button>
          <button type="button" class="sortie-cta compact" @click="downloadVictoryPhoto">
            <span class="sortie-cta-label">{{ t('message.ultramanView.photo.save') }}</span>
          </button>
        </template>
        <button type="button" class="tac-btn large accent" @click="handleStartBattle()">
          {{ t('message.ultramanView.result.playAgain') }}
        </button>
        <button type="button" class="tac-btn large" @click="handleExitToMenu">
          {{ t('message.ultramanView.result.backMenu') }}
        </button>
      </div>
    </div>

    <!-- ================= 战败结算面板 ================= -->
    <div v-if="hud.phase === 'defeat'" class="result-overlay">
      <div class="result-panel defeat">
        <div class="result-kicker">GUTS BATTLE REPORT // {{ hud.heroId.toUpperCase() }}</div>
        <h2 class="result-heading">{{ t('message.ultramanView.result.defeatTitle') }}</h2>

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
  height: 100dvh;
  overflow: hidden;
  overscroll-behavior: none;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  background: #060b16;
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

.shutter-flash {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: #ffffff;
  pointer-events: none;
  animation: shutterFade 0.26s ease-out forwards;
}

@keyframes shutterFade {
  from { opacity: 0.92; }
  to { opacity: 0; }
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
  font-size: 30px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: 1px;
  text-shadow:
    0 3px 0 #020617,
    0 0 18px rgba(2, 6, 23, 0.95);
  animation: floatArc 0.92s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  white-space: nowrap;
}

.floating-text.crit,
.floating-text.guard {
  font-size: 36px;
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
      scale(calc(var(--fscale, 1) * 1.2));
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

/* ================= 统一实时摄像头窗（变形复用零丢流） ================= */
.live-cam-frame {
  position: fixed;
  z-index: 36;
  background: rgba(6, 14, 26, 0.88);
  border: 1.5px solid rgba(56, 232, 255, 0.7);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  transition: all 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}

.live-cam-frame.hidden {
  opacity: 0;
  pointer-events: none;
  left: 18px;
  bottom: 132px;
  width: 196px;
  transform: translateY(16px);
}

/* 战斗期间收拢于左下角装甲仪上方，紧凑尺寸避免遮挡战场与左下状态仪 */
.live-cam-frame.battle-compact {
  left: 18px;
  bottom: 120px;
  width: 172px;
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
}

.live-cam-frame.battle-minimized {
  left: 18px;
  bottom: 120px;
  width: 172px;
  border-radius: 6px;
}

.live-cam-frame.battle-expanded {
  left: 18px;
  bottom: 120px;
  width: 268px;
  clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
}

/* 幕 0 变身仪式：右侧大号发光星环同框窗 */
.live-cam-frame.transform-stage {
  right: 7vw;
  top: 50%;
  transform: translateY(-50%);
  width: min(360px, 34vw);
  border-radius: 22px;
  border: 2.5px solid #38e8ff;
  box-shadow:
    0 0 36px rgba(56, 232, 255, 0.55),
    inset 0 0 28px rgba(56, 232, 255, 0.25);
}

/* 幕 5 胜利合影：右侧半屏双人同框窗（复刻视频 1 00:10-00:11） */
.live-cam-frame.victory-photo {
  right: 6vw;
  top: 50%;
  transform: translateY(-50%);
  width: min(410px, 39vw);
  border-radius: 24px;
  border: 3px solid #38e8ff;
  box-shadow: 0 0 42px rgba(56, 232, 255, 0.65);
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
.radar-badge.full { color: #4ade80; }
.radar-badge.upper { color: #38e8ff; }

.radar-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.radar-zoom-btn {
  width: 20px;
  height: 20px;
  border: 1px solid rgba(125, 211, 252, 0.45);
  background: rgba(15, 23, 42, 0.9);
  color: #e2e8f0;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.radar-viewport {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  transition: height 0.2s ease, opacity 0.2s ease;
}

.radar-viewport.collapsed {
  height: 0;
  aspect-ratio: auto;
  opacity: 0;
}

.live-cam-frame.victory-photo .radar-viewport,
.live-cam-frame.transform-stage .radar-viewport {
  aspect-ratio: 4 / 4.4;
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

.photo-countdown-num {
  position: absolute;
  right: 18px;
  bottom: 10px;
  font-size: 76px;
  font-weight: 900;
  font-style: italic;
  color: #fde047;
  text-shadow:
    0 4px 0 #020617,
    0 0 28px rgba(250, 204, 21, 0.95);
  animation: comboSlam 0.35s ease-out;
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
.radar-charge-fill.beam { background: linear-gradient(90deg, #38bdf8, #facc15); }
.radar-charge-fill.disc { background: #67e8f9; }
.radar-charge-fill.guard { background: #38bdf8; }
.radar-charge-fill.type { background: linear-gradient(90deg, #a855f7, #f472b6); }
.radar-charge-fill.spread,
.radar-charge-fill.transform {
  background: linear-gradient(90deg, #38e8ff, #facc15, #f472b6);
}

/* ================= 幕 0：宇宙星海变身仪式叠加层 ================= */
.transform-overlay {
  position: fixed;
  inset: 0;
  z-index: 38;
  pointer-events: none;
  display: flex;
  align-items: center;
  padding-left: 6vw;
}

.transform-guide-card {
  pointer-events: auto;
  width: min(300px, 38vw);
  padding: 20px 22px;
  background: rgba(6, 18, 38, 0.82);
  backdrop-filter: blur(10px);
  border: 2px solid #38e8ff;
  border-radius: 18px;
  box-shadow: 0 0 38px rgba(56, 232, 255, 0.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
}

.silhouette-svg {
  width: 96px;
  height: 136px;
  fill: rgba(56, 232, 255, 0.28);
  stroke: #38e8ff;
  filter: drop-shadow(0 0 12px rgba(56, 232, 255, 0.8));
}

.silhouette-svg .glow-limb {
  stroke: #fde047;
  animation: limbPulse 0.7s ease-in-out infinite alternate;
}

.silhouette-svg .spark-dot {
  fill: #ffffff;
  filter: drop-shadow(0 0 14px #facc15);
  animation: comboSlam 0.6s ease-in-out infinite alternate;
}

@keyframes limbPulse {
  from { stroke: #38e8ff; }
  to { stroke: #fef08a; }
}

.transform-guide-title {
  font-size: 20px;
  font-weight: 900;
  font-style: italic;
  color: #fef08a;
  letter-spacing: 1px;
}

.transform-guide-desc {
  font-size: 13px;
  color: #cbd5e1;
  line-height: 1.4;
}

.transform-bar-bg {
  width: 100%;
  height: 10px;
  background: rgba(2, 6, 23, 0.85);
  border: 1px solid rgba(56, 232, 255, 0.5);
  border-radius: 99px;
  overflow: hidden;
}

.transform-bar-fg {
  height: 100%;
  background: linear-gradient(90deg, #38e8ff, #facc15, #fb923c);
  transition: width 0.08s linear;
}

/* ================= 机库整备主菜单 ================= */
.hangar-shell {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 16px 22px 20px;
  pointer-events: none;
  background:
    linear-gradient(
      90deg,
      rgba(5, 11, 22, 0.82) 0%,
      rgba(5, 11, 22, 0.16) 28%,
      rgba(5, 11, 22, 0) 50%,
      rgba(5, 11, 22, 0.2) 70%,
      rgba(5, 11, 22, 0.86) 100%
    ),
    linear-gradient(180deg, rgba(5, 11, 22, 0.6) 0%, transparent 18%, transparent 82%, rgba(5, 11, 22, 0.68) 100%);
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

.hero-card.tiga.active { border-color: #38e8ff; background: linear-gradient(90deg, rgba(56, 232, 255, 0.2), rgba(15, 28, 48, 0.85)); }
.hero-card.tiga.active .hero-card-bar { background: #38e8ff; box-shadow: 0 0 10px #38e8ff; }
.hero-card.zero.active { border-color: #5eead4; background: linear-gradient(90deg, rgba(94, 234, 212, 0.2), rgba(15, 28, 48, 0.85)); }
.hero-card.zero.active .hero-card-bar { background: #5eead4; box-shadow: 0 0 10px #5eead4; }
.hero-card.dyna.active { border-color: #ffbd49; background: linear-gradient(90deg, rgba(255, 189, 73, 0.22), rgba(15, 28, 48, 0.85)); }
.hero-card.dyna.active .hero-card-bar { background: #ffbd49; box-shadow: 0 0 10px #ffbd49; }
.hero-card.zeta.active { border-color: #60a5fa; background: linear-gradient(90deg, rgba(96, 165, 250, 0.22), rgba(15, 28, 48, 0.85)); }
.hero-card.zeta.active .hero-card-bar { background: #60a5fa; box-shadow: 0 0 10px #60a5fa; }

.hero-card-main { flex: 1; min-width: 0; }
.hero-name-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.hero-cn { font-size: 16px; font-weight: 900; color: #ffffff; }
.hero-code { font-size: 11px; font-weight: 900; letter-spacing: 1.5px; color: #7dd3fc; }
.hero-role { margin-top: 3px; font-size: 11px; color: #94a3b8; }

.stage-pedestal-hud {
  align-self: end;
  justify-self: center;
  text-align: center;
  padding-bottom: 34px;
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

.pedestal-code { font-size: 11px; font-weight: 900; letter-spacing: 2px; color: var(--hero-accent); }
.pedestal-name { font-size: 17px; font-weight: 900; color: #ffffff; }

.form-preview-btn {
  padding: 3px 10px;
  border-radius: 3px;
  border: 1px solid rgba(250, 204, 21, 0.65);
  background: rgba(250, 204, 21, 0.14);
  color: #fef08a;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}
.form-preview-btn:hover { background: rgba(250, 204, 21, 0.28); }
.pedestal-sub { margin: 6px 0 0; font-size: 12px; color: rgba(226, 232, 240, 0.85); text-shadow: 0 2px 6px #000; }

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
.form-pill.interactive { margin-left: 6px; cursor: pointer; }
.form-pill.power, .form-pill.strong { background: rgba(239, 68, 68, 0.24); border-color: #fb7185; color: #fecdd3; }
.form-pill.sky { background: rgba(168, 85, 247, 0.24); border-color: #c084fc; color: #e9d5ff; }
.form-pill.miracle { background: rgba(14, 165, 233, 0.25); border-color: #38bdf8; color: #bae6fd; }

.deck-block { display: flex; flex-direction: column; }
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
}
.mode-tab.active {
  background: linear-gradient(90deg, #38e8ff, #60a5fa);
  color: #06101e;
  box-shadow: 0 0 14px rgba(56, 232, 255, 0.35);
}

.kaiju-list { display: flex; flex-direction: column; gap: 5px; }
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
}
.kaiju-chip:hover { border-color: rgba(250, 204, 21, 0.55); }
.kaiju-chip.active { border-color: #facc15; background: linear-gradient(90deg, rgba(250, 204, 21, 0.2), rgba(15, 28, 48, 0.85)); color: #fef08a; }
.kaiju-idx { font-size: 11px; font-weight: 900; color: #38e8ff; }
.kaiju-title { flex: 1; text-align: left; }
.kaiju-hp { font-size: 10px; color: #94a3b8; }

.arena-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.arena-pill {
  padding: 5px 10px;
  background: rgba(15, 28, 48, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.28);
  color: #cbd5e1;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
}
.arena-pill.active { border-color: #38e8ff; background: rgba(56, 232, 255, 0.18); color: #bae6fd; }

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
.camera-alert-text { font-size: 12px; color: #fecaca; }

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
.sortie-cta:hover:not(:disabled) { transform: translateY(-2px) scale(1.02); box-shadow: 0 14px 34px rgba(250, 204, 21, 0.55); }
.sortie-cta:disabled { opacity: 0.65; cursor: wait; }
.sortie-cta.compact { padding: 11px 24px; font-size: 14px; }

.moves-drawer {
  pointer-events: auto;
  margin-top: 8px;
  padding: 12px 16px;
  background: rgba(7, 15, 28, 0.94);
  border: 1px solid rgba(56, 232, 255, 0.45);
}
.moves-drawer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 8px; }
.guide-card { padding: 8px 10px; background: rgba(18, 33, 56, 0.78); border-left: 3px solid #38e8ff; }
.guide-card.ultimate { border-left-color: #facc15; background: linear-gradient(90deg, rgba(250, 204, 21, 0.16), rgba(18, 33, 56, 0.82)); }
.guide-name { font-size: 12px; font-weight: 900; color: #ffffff; }
.guide-desc { margin-top: 3px; font-size: 11px; color: #94a3b8; line-height: 1.35; }

/* ================= 实战悦动元气机大屏极简 HUD ================= */
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
  grid-template-columns: minmax(150px, 1fr) minmax(280px, 520px) minmax(150px, 1fr);
  align-items: start;
  gap: 12px;
}

.hud-top-left,
.hud-top-right {
  display: flex;
  align-items: center;
  gap: 7px;
  pointer-events: auto;
}
.hud-top-left { flex-wrap: wrap; }
.hud-top-right {
  justify-content: flex-end;
  flex-wrap: nowrap;
  white-space: nowrap;
}

.battle-menu-wrap {
  position: relative;
}

.battle-menu-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 228px;
  padding: 10px;
  background: rgba(6, 15, 30, 0.94);
  backdrop-filter: blur(12px);
  border: 1.5px solid rgba(56, 232, 255, 0.55);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.72), 0 0 22px rgba(56, 232, 255, 0.25);
  display: flex;
  flex-direction: column;
  gap: 7px;
  z-index: 60;
}

.menu-item-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  background: rgba(15, 28, 48, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.3);
  color: #e2f1ff;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;
}
.menu-item-btn:hover,
.menu-item-btn.active {
  border-color: #38e8ff;
  background: rgba(14, 65, 98, 0.82);
  color: #ffffff;
}
.menu-item-btn strong {
  color: #fde047;
  font-size: 11px;
}

.menu-item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.compact-btn {
  padding: 6px 10px;
  flex-shrink: 0;
}

.score-plate {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 13px;
  background: rgba(8, 17, 32, 0.76);
  border-left: 3px solid #facc15;
  clip-path: polygon(0 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
}
.plate-label { font-size: 10px; font-weight: 900; color: #94a3b8; }
.plate-value { font-size: 18px; font-weight: 900; color: #fde047; }

.stage-pill {
  padding: 4px 11px;
  background: rgba(56, 232, 255, 0.16);
  border: 1px solid rgba(56, 232, 255, 0.6);
  color: #bae6fd;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 0.8px;
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
}

/* 视频 2 同款顶部细长锐利红色 Boss 血条 */
.boss-slim-hud {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 2px;
}

.boss-slim-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.9);
}

.boss-wave-tag {
  padding: 2px 8px;
  background: rgba(220, 38, 38, 0.9);
  color: #ffffff;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 1px;
}

.boss-title {
  font-size: 17px;
  font-weight: 900;
  letter-spacing: 1.5px;
  color: #ffffff;
  margin-left: auto;
}

.boss-state-chip {
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 900;
  background: rgba(52, 211, 153, 0.22);
  border: 1px solid rgba(52, 211, 153, 0.7);
  color: #6ee7b7;
}
.boss-state-chip.guarding { background: rgba(96, 165, 250, 0.22); border-color: #60a5fa; color: #bfdbfe; }
.boss-state-chip.roaring { background: rgba(251, 146, 60, 0.25); border-color: #fb923c; color: #fed7aa; }

.slim-bar-track {
  position: relative;
  height: 10px;
  background: rgba(5, 10, 20, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 99px;
  overflow: hidden;
  box-shadow: 0 0 14px rgba(239, 68, 68, 0.45);
}

.slim-bar-trail {
  position: absolute;
  inset: 0 auto 0 0;
  background: #fef08a;
  transition: width 0.65s cubic-bezier(0.22, 1, 0.36, 1) 0.1s;
}

.slim-bar-fill {
  position: relative;
  height: 100%;
  background: linear-gradient(90deg, #b91c1c 0%, #ef4444 55%, #ff7a45 100%);
  box-shadow: 0 0 14px rgba(239, 68, 68, 0.9);
  transition: width 0.1s ease-out;
}

/* 视频 2 电视右侧标志性大号发光连击数 */
.stage-combo-burst {
  position: fixed;
  right: 4.5vw;
  top: 26vh;
  display: flex;
  align-items: baseline;
  gap: 6px;
  pointer-events: none;
  animation: comboSlam 0.18s cubic-bezier(0.22, 1, 0.36, 1);
}

.stage-combo-num {
  font-size: clamp(46px, 5.2vw, 76px);
  font-weight: 900;
  font-style: italic;
  line-height: 1;
  background: linear-gradient(180deg, #ffffff 0%, #7dd3fc 45%, #38bdf8 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 4px 0 rgba(2, 6, 23, 0.95)) drop-shadow(0 0 18px rgba(56, 232, 255, 0.85));
}

.stage-combo-label {
  font-size: clamp(18px, 2vw, 26px);
  font-weight: 900;
  font-style: italic;
  color: #fde047;
  text-shadow: 0 3px 0 #020617, 0 0 14px rgba(250, 204, 21, 0.75);
}

@keyframes comboSlam {
  from { transform: scale(1.42); }
  to { transform: scale(1); }
}

/* 中部弹性悬停舱：始终稳居顶部栏与底部状态/按键栏之间，彻底杜绝任何屏幕尺寸下的遮挡重叠 */
.hud-mid-dock {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  padding-bottom: 12px;
  pointer-events: none;
}

/* 幕 3 角力 QTE 红蓝进度条（内嵌动作示范小人，横向紧凑不遮主体） */
.grapple-hud {
  width: min(560px, 92vw);
  padding: 11px 18px;
  background: rgba(6, 14, 28, 0.88);
  backdrop-filter: blur(8px);
  border: 2px solid #38e8ff;
  border-radius: 14px;
  box-shadow: 0 0 32px rgba(56, 232, 255, 0.45);
  display: flex;
  align-items: center;
  gap: 14px;
  text-align: left;
}

.center-hud-body {
  flex: 1;
  min-width: 0;
}

.coach-icon.inline-icon {
  width: 56px;
  height: 56px;
}

.grapple-title {
  font-size: 17px;
  font-weight: 900;
  font-style: italic;
  color: #fef08a;
  letter-spacing: 1.2px;
  margin-bottom: 8px;
}

.grapple-track {
  position: relative;
  height: 16px;
  border-radius: 99px;
  background: linear-gradient(90deg, #dc2626, #f97316);
  border: 2px solid #ffffff;
  overflow: visible;
}

.grapple-hero-fill {
  height: 100%;
  border-radius: 99px 0 0 99px;
  background: linear-gradient(90deg, #0284c7, #38e8ff, #e0f7ff);
  box-shadow: 0 0 18px #38e8ff;
  transition: width 0.06s linear;
}

.grapple-spark {
  position: absolute;
  top: 50%;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -50%) rotate(45deg);
  background: #ffffff;
  border: 2px solid #facc15;
  box-shadow: 0 0 22px #ffffff, 0 0 32px #38e8ff;
}

.grapple-sub {
  margin-top: 6px;
  font-size: 12px;
  font-weight: 800;
  color: #bae6fd;
}

/* 幕 4 终结必杀光线特写引导条（内嵌展臂/L型动作示范小人，全屏唯一焦点） */
.finisher-bar-hud {
  width: min(560px, 92vw);
  padding: 11px 22px;
  background: linear-gradient(95deg, rgba(127, 29, 29, 0.92), rgba(180, 83, 9, 0.9));
  backdrop-filter: blur(8px);
  border-top: 2px solid #fef08a;
  border-bottom: 2px solid #38e8ff;
  clip-path: polygon(16px 0, 100% 0, calc(100% - 16px) 100%, 0 100%);
  box-shadow: 0 0 36px rgba(250, 204, 21, 0.55);
  display: flex;
  align-items: center;
  gap: 14px;
  text-align: left;
}

.finisher-headline {
  font-size: clamp(17px, 2.1vw, 22px);
  font-weight: 900;
  font-style: italic;
  color: #ffffff;
  letter-spacing: 1.2px;
  text-shadow: 0 2px 0 #020617;
  margin-bottom: 7px;
}

.finisher-progress-track {
  height: 10px;
  background: rgba(2, 6, 23, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.45);
  overflow: hidden;
}

.finisher-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #38e8ff, #facc15, #f472b6);
  transition: width 0.08s linear;
}

.finisher-sub {
  margin-top: 6px;
  font-size: 12px;
  font-weight: 800;
  color: #fef3c7;
}

/* 对波 & 预警 & 播报横幅 */
.clash-hud {
  width: min(520px, 90vw);
  padding: 10px 18px 13px;
  background: rgba(9, 14, 28, 0.92);
  border: 2px solid #facc15;
  box-shadow: 0 0 32px rgba(250, 204, 21, 0.65);
  text-align: center;
}
.clash-prompt { font-size: 14px; font-weight: 900; color: #fef08a; margin-bottom: 8px; }
.clash-tug-track { position: relative; height: 14px; background: linear-gradient(90deg, #9333ea, #ec4899); border: 1px solid #fff; }
.clash-hero-side { height: 100%; background: linear-gradient(90deg, #0284c7, #38e8ff, #fef08a); }
.clash-spark-knot { position: absolute; top: 50%; width: 22px; height: 22px; transform: translate(-50%, -50%) rotate(45deg); background: #fff; border: 2px solid #facc15; box-shadow: 0 0 18px #fff; }

.hazard-banner {
  position: fixed;
  top: 80px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 22px 8px;
  min-width: min(400px, 88vw);
  background: rgba(153, 27, 27, 0.88);
  border: 1.5px solid #fde047;
  clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  box-shadow: 0 0 24px rgba(239, 68, 68, 0.72);
  text-align: center;
  animation: hazardPulse 0.4s ease-in-out infinite alternate;
}
@keyframes hazardPulse {
  from { transform: translateX(-50%) scale(1); }
  to { transform: translateX(-50%) scale(1.03); }
}
.hazard-text { font-size: 13px; font-weight: 900; color: #fff; margin-bottom: 5px; }
.hazard-progress-bg { height: 4px; background: rgba(0, 0, 0, 0.5); overflow: hidden; }
.hazard-progress-fg { height: 100%; background: #facc15; }

.cutin-banner {
  position: fixed;
  top: 84px;
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
.cutin-banner.shifted { top: 142px; }
@keyframes cutinSlam {
  from { opacity: 0; transform: translateX(-50%) skewX(-12deg) scale(0.78); }
  to { opacity: 1; transform: translateX(-50%) skewX(0deg) scale(1); }
}

/* 底部区域 */
.hud-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
}

.bottom-right-cluster {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}

/* 右下角动态动作教学引导卡（复刻视频 1 & 视频 2 招牌互动教学！） */
.action-coach-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  min-width: 248px;
  max-width: 340px;
  background: rgba(6, 16, 34, 0.84);
  backdrop-filter: blur(8px);
  border: 2px solid rgba(56, 232, 255, 0.72);
  clip-path: polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55), 0 0 22px rgba(56, 232, 255, 0.25);
}

.action-coach-card.alert {
  border-color: #f87171;
  background: rgba(69, 10, 10, 0.88);
  box-shadow: 0 0 28px rgba(239, 68, 68, 0.65);
  animation: coachPulse 0.45s ease-in-out infinite alternate;
}

.action-coach-card.fire {
  border-color: #fb923c;
  box-shadow: 0 0 26px rgba(251, 146, 60, 0.55);
}

.action-coach-card.rainbow {
  border-color: #facc15;
  background: linear-gradient(125deg, rgba(14, 52, 92, 0.9), rgba(107, 33, 168, 0.86));
  box-shadow: 0 0 32px rgba(250, 204, 21, 0.65);
}

@keyframes coachPulse {
  from { transform: scale(1); }
  to { transform: scale(1.04); }
}

.coach-icon {
  width: 54px;
  height: 54px;
  flex-shrink: 0;
  fill: #e0f7ff;
  stroke: #7dd3fc;
}

.coach-icon .accent-limb {
  stroke: #fde047;
  filter: drop-shadow(0 0 6px #facc15);
}

.coach-icon .arrow-hint {
  fill: #4ade80;
  stroke: none;
}

.coach-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.coach-title {
  font-size: 16px;
  font-weight: 900;
  font-style: italic;
  color: #fef08a;
  letter-spacing: 0.6px;
}

.coach-desc {
  font-size: 11px;
  font-weight: 700;
  color: #e2e8f0;
  line-height: 1.35;
}

/* 左下装甲仪 */
.hero-cockpit-panel {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(330px, 52vw);
  padding: 10px 14px;
  background: rgba(8, 17, 32, 0.84);
  border: 1.5px solid rgba(56, 232, 255, 0.55);
  clip-path: polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 0 100%);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55);
}

.color-timer {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(circle, #7dd3fc 0%, #0284c7 62%, #082f49 100%);
  border: 3px solid #cbd5e1;
  box-shadow: 0 0 18px rgba(56, 232, 255, 0.85);
}
.color-timer-ring { position: absolute; inset: 4px; border-radius: 50%; border: 1px dashed rgba(255, 255, 255, 0.55); }
.color-timer-core { width: 18px; height: 18px; border-radius: 50%; background: #e0f7ff; box-shadow: 0 0 12px #38e8ff; }
.color-timer.zero { background: radial-gradient(circle, #ccfbf1 0%, #14b8a6 58%, #0f172a 100%); }
.color-timer.dyna { background: radial-gradient(circle, #dbeafe 0%, #2563eb 58%, #0f172a 100%); border-color: #fde68a; }
.color-timer.danger {
  background: radial-gradient(circle, #fecaca 0%, #dc2626 62%, #450a0a 100%);
  box-shadow: 0 0 24px rgba(239, 68, 68, 0.95);
  animation: timerDangerBlink 0.5s ease-in-out infinite alternate;
}
.color-timer.danger .color-timer-core { background: #fee2e2; box-shadow: 0 0 14px #ef4444; }
@keyframes timerDangerBlink {
  from { opacity: 1; transform: scale(1.06); }
  to { opacity: 0.48; transform: scale(0.95); }
}

.hero-meters { flex: 1; min-width: 0; }
.meter-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 800; margin-bottom: 4px; }
.energy-head { margin-top: 7px; }
.meter-title { color: #cbd5e1; }
.meter-val { color: #7dd3fc; }

.armor-bar-shell {
  position: relative;
  height: 10px;
  background: rgba(2, 6, 23, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.22);
  transform: skewX(-14deg);
  overflow: hidden;
}
.armor-bar-trail { position: absolute; inset: 0 auto 0 0; background: #fef08a; transition: width 0.65s ease 0.1s; }
.armor-bar-fill { position: relative; height: 100%; transition: width 0.12s ease-out; }
.armor-bar-fill.hero { background: linear-gradient(90deg, #0284c7, var(--hero-accent)); }
.armor-bar-fill.hero.danger { background: linear-gradient(90deg, #dc2626, #f97316); }

.energy-status { font-size: 11px; color: #94a3b8; }
.energy-status.ready { color: #38e8ff; }
.energy-status.full { color: #fde047; animation: timerDangerBlink 0.6s infinite alternate; }
.energy-bar-shell { position: relative; height: 9px; background: rgba(2, 6, 23, 0.82); border: 1px solid rgba(255, 255, 255, 0.2); transform: skewX(-14deg); overflow: hidden; }
.energy-threshold-tick { position: absolute; top: 0; bottom: 0; width: 2px; background: rgba(255, 255, 255, 0.65); z-index: 2; }
.energy-bar-fill { height: 100%; background: #475569; transition: width 0.14s ease; }
.energy-bar-fill.ready { background: linear-gradient(90deg, #0284c7, #38e8ff); }
.energy-bar-fill.full { background: linear-gradient(90deg, #38e8ff, #facc15, #fb923c); box-shadow: 0 0 12px #facc15; }

/* 街机按键甲板 */
.arcade-deck { pointer-events: auto; display: flex; align-items: flex-end; gap: 10px; }
.movement-pad { display: flex; gap: 6px; }
.strike-pad { display: flex; flex-direction: column; gap: 6px; }
.strike-row { display: flex; justify-content: flex-end; gap: 6px; }

.deck-btn {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 64px;
  padding: 6px 10px;
  background: rgba(11, 22, 38, 0.9);
  border: 1.5px solid rgba(148, 163, 184, 0.42);
  clip-path: polygon(6px 0, 100% 0, calc(100% - 6px) 100%, 0 100%);
  color: #f8fafc;
  font-size: 11px;
  font-weight: 900;
  cursor: pointer;
  touch-action: none;
}
.deck-btn kbd { font-size: 9px; opacity: 0.72; font-family: inherit; }
.deck-btn:active:not(:disabled) { transform: scale(0.94); }
.deck-btn.guard { border-color: #38bdf8; color: #bae6fd; }
.deck-btn.punch { border-color: #fb923c; color: #ffedd5; }
.deck-btn.kick { border-color: #f97316; }
.deck-btn.disc { border-color: #22d3ee; }
.deck-btn.beam { min-width: 96px; border-color: #64748b; }
.deck-btn.beam.ready { border-color: #38e8ff; background: rgba(14, 78, 118, 0.9); color: #e0f7ff; }
.deck-btn.beam.full { border-color: #facc15; background: linear-gradient(95deg, #0284c7, #eab308); color: #050d1a; }
.cd-veil { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(2, 6, 23, 0.72); pointer-events: none; }

/* ================= 幕 5：胜利星海合影层 ================= */
.victory-photo-shell {
  position: fixed;
  inset: 0;
  z-index: 42;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 20px 28px 26px;
}

.victory-top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.victory-badge {
  padding: 8px 22px;
  background: linear-gradient(95deg, rgba(14, 65, 110, 0.92), rgba(56, 189, 248, 0.85));
  border: 1.5px solid #fef08a;
  clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  font-size: 20px;
  font-weight: 900;
  font-style: italic;
  color: #ffffff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
}

.victory-stats-strip {
  display: flex;
  gap: 18px;
  padding: 8px 18px;
  background: rgba(6, 14, 28, 0.84);
  border: 1px solid rgba(56, 232, 255, 0.45);
  font-size: 13px;
  color: #cbd5e1;
}
.victory-stats-strip strong { color: #fde047; font-size: 16px; margin-left: 4px; }

.photo-preview-card {
  align-self: center;
  width: min(760px, 86vw);
  border-radius: 16px;
  overflow: hidden;
  border: 3px solid #38e8ff;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75), 0 0 36px rgba(56, 232, 255, 0.45);
  pointer-events: auto;
}
.photo-preview-img { display: block; width: 100%; height: auto; }

.victory-bottom-actions {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* ================= 加载遮罩 & 战败结算 ================= */
.loading-overlay,
.result-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 10, 22, 0.78);
  backdrop-filter: blur(8px);
}

.loading-box {
  width: min(360px, 86vw);
  padding: 24px 28px;
  background: rgba(8, 17, 32, 0.94);
  border: 1.5px solid #38e8ff;
  text-align: center;
}
.loading-title { font-size: 16px; font-weight: 900; color: #e0f7ff; margin-bottom: 14px; }
.loading-bar-bg { height: 10px; background: rgba(15, 23, 42, 0.9); overflow: hidden; margin-bottom: 8px; }
.loading-bar-fg { height: 100%; background: linear-gradient(90deg, #38e8ff, #facc15); transition: width 0.2s; }
.loading-num { font-size: 13px; font-weight: 800; color: #fde047; }

.result-panel {
  width: min(560px, 92vw);
  padding: 28px 32px;
  background: rgba(8, 17, 32, 0.95);
  border: 2px solid #f87171;
  clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);
  text-align: center;
}
.result-kicker { font-size: 11px; font-weight: 900; letter-spacing: 2px; color: #f87171; }
.result-heading { margin: 8px 0 20px; font-size: 28px; font-weight: 900; font-style: italic; color: #ffffff; }
.result-metrics { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 22px; }
.metric-tile { padding: 12px; background: rgba(15, 28, 48, 0.85); border: 1px solid rgba(148, 163, 184, 0.25); }
.metric-label { display: block; font-size: 11px; color: #94a3b8; margin-bottom: 4px; }
.metric-val { font-size: 24px; font-weight: 900; color: #ffffff; }
.metric-val.gold { color: #fde047; }
.metric-val.cyan { color: #38e8ff; }
.result-btns { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }

.interactive-hud {
  pointer-events: auto;
  touch-action: none;
  cursor: pointer;
}

@media (hover: none) and (pointer: coarse) {
  .deck-btn kbd {
    display: none;
  }
}

@media (max-width: 960px) {
  .hangar-shell {
    padding: calc(10px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
      calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
  }
  .hangar-body {
    grid-template-columns: 1fr;
    overflow-y: auto;
    align-content: end;
    gap: 10px;
  }
  .stage-pedestal-hud {
    display: none;
  }
  .battle-hud {
    padding: calc(10px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
      calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
  }
  .hud-top {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      'left right'
      'boss boss';
    row-gap: 6px;
  }
  .hud-top-left {
    grid-area: left;
  }
  .hud-top-right {
    grid-area: right;
  }
  .boss-slim-hud {
    grid-area: boss;
  }
  .hud-bottom {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .hero-cockpit-panel {
    width: 100%;
    max-width: none;
  }
  .bottom-right-cluster {
    align-items: stretch;
    gap: 6px;
  }
  .arcade-deck {
    justify-content: space-between;
    width: 100%;
  }
}

/* ================= 手机竖屏专属深度适配（<= 768px） ================= */
@media (max-width: 768px) {
  .tpc-tag {
    display: none;
  }
  .hangar-topbar {
    gap: 6px;
    flex-wrap: nowrap;
  }
  .hangar-title {
    font-size: 15px;
    letter-spacing: 0.4px;
    white-space: nowrap;
  }
  .topbar-left,
  .topbar-right {
    gap: 5px;
    flex-wrap: nowrap;
  }
  .tac-btn {
    padding: 6px 9px;
    font-size: 11px;
    white-space: nowrap;
  }

  /* 机库菜单：上半屏保留 3D 迪迦舞台展示窗，下半屏轻量化抽屉，英雄/怪兽/场景均横向滑动选单 */
  .hangar-shell {
    background: linear-gradient(
      180deg,
      rgba(5, 11, 22, 0.72) 0%,
      rgba(5, 11, 22, 0.05) 18%,
      rgba(5, 11, 22, 0.08) 42%,
      rgba(5, 11, 22, 0.92) 66%,
      rgba(5, 11, 22, 0.96) 100%
    );
  }
  .hangar-body {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: stretch;
    gap: 8px;
    padding-top: 26dvh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
  .stage-pedestal-hud {
    display: block;
    align-self: center;
    padding-bottom: 2px;
  }
  .pedestal-plate {
    padding: 5px 12px;
    gap: 7px;
  }
  .pedestal-name {
    font-size: 14px;
  }
  .pedestal-sub {
    display: none;
  }
  .hangar-wing {
    max-height: none;
    overflow: visible;
    padding: 10px 12px;
    gap: 9px;
    clip-path: none;
    border-radius: 12px;
    background: rgba(8, 17, 32, 0.84);
  }
  .wing-header {
    margin-bottom: 4px;
    font-size: 10px;
  }
  .hero-roster {
    flex-direction: row;
    overflow-x: auto;
    gap: 8px;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .hero-card {
    flex: 0 0 auto;
    min-width: 118px;
    padding: 8px 10px;
    clip-path: none;
    border-radius: 8px;
  }
  .hero-card:hover {
    transform: none;
  }
  .hero-card-bar {
    margin-right: 8px;
  }
  .hero-cn {
    font-size: 14px;
  }
  .hero-code {
    display: none;
  }
  .hero-role {
    font-size: 10px;
    white-space: nowrap;
  }
  .kaiju-list {
    flex-direction: row;
    overflow-x: auto;
    gap: 6px;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .kaiju-chip {
    flex: 0 0 auto;
    padding: 7px 10px;
    border-radius: 7px;
    white-space: nowrap;
  }
  .arena-grid {
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
    -webkit-overflow-scrolling: touch;
  }
  .arena-pill {
    flex: 0 0 auto;
    padding: 6px 10px;
    border-radius: 6px;
    white-space: nowrap;
  }
  .sortie-cta {
    width: 100%;
    padding: 13px 18px;
    font-size: 16px;
    min-height: 48px;
  }
  .moves-drawer {
    max-height: 36dvh;
    overflow-y: auto;
  }

  /* 幕 0 变身仪式与幕 5 合影：竖屏上下排版 */
  .transform-overlay {
    padding: calc(16px + env(safe-area-inset-top)) 14px calc(18px + env(safe-area-inset-bottom));
    align-items: flex-end;
    justify-content: center;
  }
  .transform-guide-card {
    width: min(360px, 100%);
    padding: 14px 16px;
    gap: 8px;
  }
  .silhouette-svg {
    width: 64px;
    height: 92px;
  }
  .transform-guide-title {
    font-size: 17px;
  }
  .live-cam-frame.transform-stage {
    right: 12px;
    left: auto;
    top: calc(14px + env(safe-area-inset-top));
    transform: none;
    width: min(148px, 38vw);
    border-radius: 14px;
  }
  .live-cam-frame.victory-photo {
    right: 50%;
    top: calc(74px + env(safe-area-inset-top));
    transform: translateX(50%);
    width: min(230px, 60vw);
    border-radius: 18px;
  }
  .live-cam-frame.battle-compact,
  .live-cam-frame.battle-minimized {
    left: auto;
    right: calc(10px + env(safe-area-inset-right));
    bottom: auto;
    top: calc(86px + env(safe-area-inset-top));
    width: 106px;
    clip-path: none;
    border-radius: 10px;
  }
  .live-cam-frame.battle-expanded {
    left: auto;
    right: calc(10px + env(safe-area-inset-right));
    bottom: auto;
    top: calc(86px + env(safe-area-inset-top));
    width: 158px;
    clip-path: none;
    border-radius: 12px;
  }
  .radar-footer {
    padding: 3px 6px;
    font-size: 10px;
  }

  /* 实战顶栏极致紧凑不挡视野 */
  .score-plate {
    padding: 4px 9px;
    gap: 5px;
  }
  .plate-value {
    font-size: 15px;
  }
  .stage-pill {
    padding: 3px 8px;
    font-size: 10px;
  }
  .boss-title {
    font-size: 14px;
  }
  .slim-bar-track {
    height: 8px;
  }
  .hazard-banner {
    top: calc(92px + env(safe-area-inset-top));
    padding: 5px 14px 6px;
    min-width: min(330px, 92vw);
  }
  .hazard-text {
    font-size: 12px;
  }
  .cutin-banner {
    top: calc(94px + env(safe-area-inset-top));
    padding: 5px 18px;
    font-size: 16px;
  }
  .cutin-banner.shifted {
    top: calc(144px + env(safe-area-inset-top));
  }
  .stage-combo-burst {
    right: 12px;
    top: 22dvh;
  }
  .stage-combo-num {
    font-size: 40px;
  }
  .stage-combo-label {
    font-size: 15px;
  }

  /* 中部角力/必杀互动条移动端紧凑化 */
  .grapple-hud,
  .finisher-bar-hud {
    padding: 9px 14px;
    gap: 10px;
  }
  .coach-icon.inline-icon {
    width: 42px;
    height: 42px;
  }
  .grapple-title,
  .finisher-headline {
    font-size: 15px;
    margin-bottom: 5px;
  }
  .grapple-sub,
  .finisher-sub {
    font-size: 11px;
  }

  /* 底部装甲状态条瘦身 + 动作指引单行化 + 双拇指大热区按键 */
  .hero-cockpit-panel {
    padding: 7px 10px;
    gap: 9px;
    clip-path: none;
    border-radius: 10px;
  }
  .color-timer {
    width: 34px;
    height: 34px;
    border-width: 2px;
  }
  .color-timer-core {
    width: 14px;
    height: 14px;
  }
  .meter-head {
    font-size: 10px;
    margin-bottom: 2px;
  }
  .energy-head {
    margin-top: 4px;
  }
  .armor-bar-shell,
  .energy-bar-shell {
    height: 7px;
  }
  .action-coach-card {
    min-width: 0;
    max-width: none;
    width: 100%;
    padding: 6px 10px;
    gap: 8px;
    clip-path: none;
    border-radius: 9px;
  }
  .action-coach-card .coach-icon {
    width: 34px;
    height: 34px;
  }
  .coach-title {
    font-size: 13px;
  }
  .coach-desc {
    font-size: 10px;
  }
  .arcade-deck {
    flex-direction: row;
    align-items: flex-end;
    justify-content: space-between;
    gap: 8px;
  }
  .movement-pad {
    display: grid;
    grid-template-columns: repeat(2, minmax(52px, 1fr));
    gap: 6px;
    width: 42%;
    max-width: 162px;
  }
  .movement-pad .deck-btn.guard {
    grid-column: 1 / -1;
    order: -1;
    min-height: 44px;
  }
  .strike-pad {
    width: 58%;
    gap: 6px;
  }
  .strike-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }
  .deck-btn {
    min-width: 0;
    min-height: 46px;
    padding: 6px 4px;
    clip-path: none;
    border-radius: 10px;
    font-size: 13px;
  }
  .deck-btn kbd {
    display: none;
  }
  .strike-row.lower .deck-btn {
    min-height: 52px;
    font-size: 14px;
  }
  .deck-btn.beam {
    min-width: 0;
  }
  .floating-text {
    font-size: 24px;
  }
  .floating-text.crit,
  .floating-text.guard {
    font-size: 28px;
  }

  .victory-photo-shell {
    padding: calc(12px + env(safe-area-inset-top)) 12px calc(16px + env(safe-area-inset-bottom));
  }
  .victory-badge {
    font-size: 15px;
    padding: 6px 14px;
  }
  .victory-stats-strip {
    width: 100%;
    justify-content: space-around;
    gap: 8px;
    padding: 6px 10px;
    font-size: 11px;
  }
  .victory-bottom-actions {
    gap: 8px;
  }
  .victory-bottom-actions .tac-btn.large,
  .victory-bottom-actions .sortie-cta.compact {
    padding: 10px 14px;
    font-size: 13px;
  }
}

/* ================= 手机横屏矮屏适配（如 844×390） ================= */
@media (max-height: 500px) and (orientation: landscape) {
  .hangar-shell {
    padding: calc(8px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right))
      calc(8px + env(safe-area-inset-bottom)) calc(14px + env(safe-area-inset-left));
  }
  .tpc-tag,
  .pedestal-sub {
    display: none;
  }
  .hangar-title {
    font-size: 18px;
  }
  .hangar-body {
    grid-template-columns: minmax(195px, 235px) 1fr minmax(235px, 285px);
    gap: 10px;
    overflow: hidden;
  }
  .hangar-wing {
    max-height: calc(100dvh - 64px);
    padding: 9px 11px;
    gap: 7px;
  }
  .hero-card {
    padding: 7px 9px;
  }
  .hero-cn {
    font-size: 13px;
  }
  .sortie-cta {
    padding: 10px 16px;
    font-size: 14px;
  }
  .battle-hud {
    padding: calc(6px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
      calc(8px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
  }
  .hud-top {
    grid-template-columns: auto minmax(200px, 380px) auto;
    grid-template-areas: none;
  }
  .hud-top-left,
  .hud-top-right,
  .boss-slim-hud {
    grid-area: auto;
  }
  .boss-title {
    font-size: 14px;
  }
  .hud-bottom {
    flex-direction: row;
    align-items: flex-end;
    justify-content: space-between;
    gap: 10px;
  }
  .hero-cockpit-panel {
    width: min(250px, 34vw);
    padding: 6px 9px;
    gap: 8px;
  }
  .color-timer {
    width: 30px;
    height: 30px;
  }
  .action-coach-card {
    display: none;
  }
  .bottom-right-cluster {
    align-items: flex-end;
    width: auto;
  }
  .arcade-deck {
    width: auto;
    gap: 8px;
  }
  .deck-btn {
    min-width: 54px;
    min-height: 40px;
    padding: 4px 7px;
    font-size: 12px;
  }
  .deck-btn kbd {
    display: none;
  }
  .deck-btn.beam {
    min-width: 78px;
  }
  .live-cam-frame.battle-compact,
  .live-cam-frame.battle-minimized {
    left: calc(12px + env(safe-area-inset-left));
    bottom: 84px;
    top: auto;
    right: auto;
    width: 118px;
  }
  .grapple-hud,
  .finisher-bar-hud {
    padding: 7px 14px;
  }
  .coach-icon.inline-icon {
    width: 38px;
    height: 38px;
  }
  .hazard-banner {
    top: 56px;
  }
  .cutin-banner {
    top: 56px;
    font-size: 16px;
  }
}
.ui-svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.icon-btn,
.inline-svg-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 全屏战斗视觉冲击帧层（重击/弹反/子弹时间闪避/受击边缘光脉冲） */
.impact-screen-fx {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 38;
  animation: impactEdgeFlash 0.22s ease-out forwards;
}
.impact-screen-fx.heavy {
  box-shadow: inset 0 0 85px rgba(250, 204, 21, 0.55), inset 0 0 22px rgba(255, 255, 255, 0.45);
}
.impact-screen-fx.parry {
  box-shadow: inset 0 0 95px rgba(56, 232, 255, 0.68), inset 0 0 26px rgba(254, 240, 138, 0.45);
}
.impact-screen-fx.dodge {
  box-shadow: inset 0 0 110px rgba(74, 222, 128, 0.58), inset 0 0 28px rgba(56, 232, 255, 0.35);
}
.impact-screen-fx.hurt {
  box-shadow: inset 0 0 115px rgba(239, 68, 68, 0.72), inset 0 0 28px rgba(248, 113, 113, 0.45);
}
@keyframes impactEdgeFlash {
  0% { opacity: 1; }
  100% { opacity: 0; }
}

/* 机库三维能力条与体感试招靶场入口 */
.hero-stat-bars {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  margin-top: 6px;
}
.stat-seg {
  height: 3px;
  background: rgba(148, 163, 184, 0.22);
  overflow: hidden;
}
.stat-seg i {
  display: block;
  height: 100%;
  background: #f97316;
}
.stat-seg.spd i { background: #38e8ff; }
.stat-seg.eng i { background: #facc15; }

.cta-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.practice-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 9px 14px;
  background: rgba(12, 28, 48, 0.88);
  border: 1px solid rgba(56, 232, 255, 0.52);
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
  color: #7dd3fc;
  font-size: 13px;
  font-weight: 800;
  letter-spacing: 0.8px;
  cursor: pointer;
  transition: all 0.16s ease;
}
.practice-cta:hover {
  background: rgba(18, 52, 82, 0.96);
  border-color: #7dd3fc;
  color: #ffffff;
}

/* 开场站位校准站距徽章 */
.distance-pill {
  display: inline-block;
  padding: 4px 12px;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 1px;
  border: 1px solid rgba(56, 232, 255, 0.6);
  background: rgba(14, 116, 144, 0.35);
  color: #67e8f9;
}
.distance-pill.ok {
  border-color: rgba(74, 222, 128, 0.78);
  background: rgba(21, 128, 61, 0.38);
  color: #86efac;
}
.distance-pill.too-close,
.distance-pill.too-far,
.distance-pill.off-center {
  border-color: rgba(250, 204, 21, 0.78);
  background: rgba(161, 98, 7, 0.38);
  color: #fde047;
}

/* Boss 分段刻度血条与机制提示条 */
.slim-bar-track.segmented {
  position: relative;
}
.hp-seg-ticks {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  pointer-events: none;
}
.hp-seg-ticks span {
  border-right: 1px solid rgba(2, 6, 23, 0.65);
}
.special-tactic-banner {
  margin-top: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 900;
  letter-spacing: 0.6px;
  text-align: center;
  color: #fef08a;
  background: linear-gradient(90deg, rgba(15, 23, 42, 0.2), rgba(234, 88, 12, 0.72), rgba(15, 23, 42, 0.2));
  border-top: 1px solid rgba(250, 204, 21, 0.55);
  border-bottom: 1px solid rgba(250, 204, 21, 0.55);
}

/* 主动终结光线就绪光带 */
.finisher-ready-cta {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 22px;
  background: linear-gradient(90deg, rgba(14, 116, 144, 0.92), rgba(234, 179, 8, 0.92));
  border: 2px solid #fef08a;
  clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%);
  color: #020617;
  font-size: 15px;
  font-weight: 900;
  letter-spacing: 1px;
  cursor: pointer;
  box-shadow: 0 0 28px rgba(250, 204, 21, 0.62);
  animation: finisherPulse 1.1s ease-in-out infinite;
}
@keyframes finisherPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}

/* 护盾耐力细条 */
.shield-stamina-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
}
.shield-stamina-label {
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.5px;
  color: #93c5fd;
  white-space: nowrap;
}
.shield-stamina-track {
  flex: 1;
  height: 4px;
  background: rgba(15, 23, 42, 0.78);
  border: 1px solid rgba(96, 165, 250, 0.32);
  overflow: hidden;
}
.shield-stamina-fill {
  height: 100%;
  background: linear-gradient(90deg, #38bdf8, #a5f3fc);
  transition: width 0.08s linear;
}
.shield-stamina-fill.low {
  background: linear-gradient(90deg, #ef4444, #fb923c);
}

/* 动作教学卡关节关键帧动画 */
.coach-icon.anim-punch .coach-body-rig {
  animation: coachPunch 0.7s ease-in-out infinite;
}
.coach-icon.anim-crouch-dodge .coach-body-rig {
  animation: coachCrouch 0.85s ease-in-out infinite;
}
.coach-icon.anim-jump-dodge .coach-body-rig {
  animation: coachJump 0.85s ease-in-out infinite;
}
.coach-icon.anim-guard .coach-body-rig {
  animation: coachGuard 0.9s ease-in-out infinite;
}
.coach-icon.anim-beam-spread .coach-body-rig,
.coach-icon.anim-disc-illusion .coach-body-rig {
  animation: coachPulse 0.95s ease-in-out infinite;
}
@keyframes coachPunch {
  0%, 100% { transform: translateX(0); }
  45% { transform: translateX(5px); }
}
@keyframes coachCrouch {
  0%, 100% { transform: translateY(0) scaleY(1); }
  50% { transform: translateY(10px) scaleY(0.84); }
}
@keyframes coachJump {
  0%, 100% { transform: translateY(0); }
  45% { transform: translateY(-9px); }
}
@keyframes coachGuard {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}
@keyframes coachPulse {
  0%, 100% { opacity: 0.85; transform: scale(0.98); }
  50% { opacity: 1; transform: scale(1.05); }
}

.movement-pad {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.move-row {
  display: flex;
  gap: 5px;
  justify-content: center;
}

/* S/A/B/C 防卫队战评大印章与荣誉勋章 */
.victory-rank-cluster {
  display: inline-flex;
  align-items: center;
  gap: 12px;
}
.rank-stamp {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  font-size: 28px;
  font-weight: 900;
  font-style: italic;
  border: 2px solid #facc15;
  background: rgba(15, 23, 42, 0.88);
  color: #fef08a;
  box-shadow: 0 0 20px rgba(250, 204, 21, 0.5);
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
}
.rank-stamp.rank-S {
  color: #fef08a;
  border-color: #facc15;
  background: linear-gradient(135deg, rgba(234, 179, 8, 0.35), rgba(15, 23, 42, 0.92));
}
.rank-stamp.rank-A {
  color: #67e8f9;
  border-color: #38e8ff;
}
.victory-badge-strip {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
}
.honor-chip {
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.6px;
  color: #fef08a;
  background: rgba(234, 179, 8, 0.16);
  border: 1px solid rgba(250, 204, 21, 0.55);
  clip-path: polygon(5px 0, 100% 0, calc(100% - 5px) 100%, 0 100%);
}
</style>
