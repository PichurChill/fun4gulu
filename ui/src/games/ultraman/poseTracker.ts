import type { DistanceHint, GestureActiveCue, PoseLandmark } from './types'

export interface TrackedPose {
  landmarks: PoseLandmark[]
  worldLandmarks: PoseLandmark[]
  /** 镜像画面下的水平中心 [0, 1]，0.5 为正中央，越小越靠左 */
  mirroredCenterX: number
  /** 单人精细左手 21 关节（屏幕归一化坐标 & 3D 米制世界坐标） */
  leftHandLandmarks?: PoseLandmark[] | null
  leftHandWorldLandmarks?: PoseLandmark[] | null
  /** 单人精细右手 21 关节（屏幕归一化坐标 & 3D 米制世界坐标） */
  rightHandLandmarks?: PoseLandmark[] | null
  rightHandWorldLandmarks?: PoseLandmark[] | null
}

const TASKS_VISION_URL =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/vision_bundle.mjs'
const TASKS_WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.3/wasm'
const POSE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

interface TasksVisionModule {
  FilesetResolver: { forVisionTasks(path: string): Promise<unknown> }
  PoseLandmarker: {
    createFromOptions(fileset: unknown, opts: Record<string, unknown>): Promise<PoseLandmarkerLike>
  }
  HandLandmarker?: {
    createFromOptions(fileset: unknown, opts: Record<string, unknown>): Promise<HandLandmarkerLike>
  }
}

interface PoseLandmarkerLike {
  detectForVideo(
    video: HTMLVideoElement,
    timestamp: number,
  ): {
    landmarks?: { x: number; y: number; z?: number; visibility?: number }[][]
    worldLandmarks?: { x: number; y: number; z?: number; visibility?: number }[][]
  }
  close(): void
}

interface HandLandmarkerLike {
  detectForVideo(
    video: HTMLVideoElement,
    timestamp: number,
  ): {
    landmarks?: { x: number; y: number; z?: number }[][]
    worldLandmarks?: { x: number; y: number; z?: number }[][]
    handednesses?: { categoryName?: string; score?: number }[][]
  }
  close(): void
}

let cachedVisionPromise: Promise<{ vision: TasksVisionModule; fileset: unknown }> | null = null

async function loadVisionRuntime(): Promise<{ vision: TasksVisionModule; fileset: unknown }> {
  if (!cachedVisionPromise) {
    cachedVisionPromise = (async () => {
      const vision = (await import(/* @vite-ignore */ TASKS_VISION_URL)) as unknown as TasksVisionModule
      const fileset = await vision.FilesetResolver.forVisionTasks(TASKS_WASM_URL)
      return { vision, fileset }
    })().catch((err) => {
      cachedVisionPromise = null
      throw err
    })
  }
  return cachedVisionPromise
}

/**
 * 一欧元自适应低通滤波器（One-Euro Filter）：
 * 静止时强抑抖动，高速挥拳/踢腿/闪避时拉高截止频率，降低爆发瞬间的相位延迟与削峰。
 */
class OneEuroScalar {
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev: number | null = null

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly dCutoff = 1.2,
  ) {}

  private smoothingFactor(dt: number, cutoff: number): number {
    const r = 2 * Math.PI * cutoff * dt
    return r / (r + 1)
  }

  public filter(value: number, tSec: number): number {
    if (this.xPrev === null || this.tPrev === null) {
      this.xPrev = value
      this.tPrev = tSec
      this.dxPrev = 0
      return value
    }
    const dt = Math.max(1 / 240, Math.min(0.15, tSec - this.tPrev))
    this.tPrev = tSec

    const dx = (value - this.xPrev) / dt
    const aD = this.smoothingFactor(dt, this.dCutoff)
    const dxHat = aD * dx + (1 - aD) * this.dxPrev
    this.dxPrev = dxHat

    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat)
    const a = this.smoothingFactor(dt, cutoff)
    const xHat = a * value + (1 - a) * this.xPrev
    this.xPrev = xHat
    return xHat
  }

  public reset() {
    this.xPrev = null
    this.dxPrev = 0
    this.tPrev = null
  }
}

/** 单人 33 点 2D+3D 关节一欧元滤波组 */
class PoseLandmarkFilterBank {
  private filters2D: [OneEuroScalar, OneEuroScalar, OneEuroScalar][] = []
  private filters3D: [OneEuroScalar, OneEuroScalar, OneEuroScalar][] = []
  private lastT = -Infinity

  constructor() {
    for (let i = 0; i < 33; i++) {
      // 提高四肢末端截止频率，减少 24~30fps 摄像头下的跟手延迟与出拳削峰
      const isLimb = (i >= 13 && i <= 22) || (i >= 25 && i <= 32)
      const minCutoff2D = isLimb ? 4.8 : 2.2
      const beta2D = isLimb ? 48.0 : 14.0
      const minCutoff3D = isLimb ? 4.2 : 1.9
      const beta3D = isLimb ? 36.0 : 11.0
      this.filters2D.push([
        new OneEuroScalar(minCutoff2D, beta2D),
        new OneEuroScalar(minCutoff2D, beta2D),
        new OneEuroScalar(minCutoff2D * 0.85, beta2D * 0.78),
      ])
      this.filters3D.push([
        new OneEuroScalar(minCutoff3D, beta3D),
        new OneEuroScalar(minCutoff3D, beta3D),
        new OneEuroScalar(minCutoff3D * 0.85, beta3D * 0.72),
      ])
    }
  }

  public apply(
    raw2D: PoseLandmark[],
    raw3D: PoseLandmark[],
    nowMs: number,
  ): { landmarks: PoseLandmark[]; worldLandmarks: PoseLandmark[] } {
    const tSec = nowMs * 0.001
    if (nowMs - this.lastT > 450 || nowMs < this.lastT) {
      this.reset()
    }
    this.lastT = nowMs

    const landmarks: PoseLandmark[] = raw2D.map((p, idx) => {
      const f = this.filters2D[idx]
      if (!f || (p.visibility ?? 1) < 0.18) {
        return { x: p.x, y: p.y, z: p.z ?? 0, visibility: p.visibility ?? 1 }
      }
      return {
        x: f[0].filter(p.x, tSec),
        y: f[1].filter(p.y, tSec),
        z: f[2].filter(p.z ?? 0, tSec),
        visibility: p.visibility ?? 1,
      }
    })

    const worldLandmarks: PoseLandmark[] =
      raw3D.length >= 33
        ? raw3D.map((p, idx) => {
            const f = this.filters3D[idx]
            const vis = p.visibility ?? landmarks[idx]?.visibility ?? 1
            if (!f || vis < 0.18) {
              return { x: p.x, y: p.y, z: p.z ?? 0, visibility: vis }
            }
            return {
              x: f[0].filter(p.x, tSec),
              y: f[1].filter(p.y, tSec),
              z: f[2].filter(p.z ?? 0, tSec),
              visibility: vis,
            }
          })
        : []

    return { landmarks, worldLandmarks }
  }

  public reset() {
    for (const tri of this.filters2D) {
      tri[0].reset()
      tri[1].reset()
      tri[2].reset()
    }
    for (const tri of this.filters3D) {
      tri[0].reset()
      tri[1].reset()
      tri[2].reset()
    }
  }
}

/** 单手 21 点 2D+3D 关节一欧元滤波组 */
class HandLandmarkFilterBank {
  private filters2D: [OneEuroScalar, OneEuroScalar, OneEuroScalar][] = []
  private filters3D: [OneEuroScalar, OneEuroScalar, OneEuroScalar][] = []
  private lastT = -Infinity

  constructor() {
    for (let i = 0; i < 21; i++) {
      const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20
      const minCut = isTip ? 3.2 : 2.5
      const beta = isTip ? 28.0 : 20.0
      this.filters2D.push([
        new OneEuroScalar(minCut, beta),
        new OneEuroScalar(minCut, beta),
        new OneEuroScalar(minCut * 0.85, beta * 0.72),
      ])
      this.filters3D.push([
        new OneEuroScalar(minCut, beta * 0.88),
        new OneEuroScalar(minCut, beta * 0.88),
        new OneEuroScalar(minCut * 0.85, beta * 0.7),
      ])
    }
  }

  public apply(
    raw2D: PoseLandmark[],
    raw3D: PoseLandmark[],
    nowMs: number,
  ): { landmarks: PoseLandmark[]; worldLandmarks: PoseLandmark[] } {
    const tSec = nowMs * 0.001
    if (nowMs - this.lastT > 420 || nowMs < this.lastT) {
      this.reset()
    }
    this.lastT = nowMs

    const landmarks: PoseLandmark[] = raw2D.map((p, idx) => {
      const f = this.filters2D[idx]
      if (!f) return { x: p.x, y: p.y, z: p.z ?? 0, visibility: 1 }
      return {
        x: f[0].filter(p.x, tSec),
        y: f[1].filter(p.y, tSec),
        z: f[2].filter(p.z ?? 0, tSec),
        visibility: 1,
      }
    })
    const worldLandmarks: PoseLandmark[] =
      raw3D.length >= 21
        ? raw3D.map((p, idx) => {
            const f = this.filters3D[idx]
            if (!f) return { x: p.x, y: p.y, z: p.z ?? 0, visibility: 1 }
            return {
              x: f[0].filter(p.x, tSec),
              y: f[1].filter(p.y, tSec),
              z: f[2].filter(p.z ?? 0, tSec),
              visibility: 1,
            }
          })
        : []
    return { landmarks, worldLandmarks }
  }

  public reset() {
    for (const tri of this.filters2D) {
      tri[0].reset()
      tri[1].reset()
      tri[2].reset()
    }
    for (const tri of this.filters3D) {
      tri[0].reset()
      tri[1].reset()
      tri[2].reset()
    }
  }
}

/**
 * 低延迟全身姿态追踪器：
 * - 专注单模型 MediaPipe PoseLandmarker (lite) 避免双神经网络争夺 WebGL GPU 导致主线程卡顿
 * - 摄像头采用 480x360@30fps 匹配神经网络输入尺寸，大幅降低视频解码与纹理上传开销
 * - 自适应推理帧预算调度：按单次推理耗时动态节流，把 70%+ 主线程时间留给 3D 渲染
 */
export class UltraPoseTracker {
  private landmarker: PoseLandmarkerLike | null = null
  private handLandmarker: HandLandmarkerLike | null = null
  private stream: MediaStream | null = null
  private session = 0
  private rafId = 0
  private lastVideoTime = -1
  private lastDetectTimestamp = 0
  private lastInferAt = -Infinity
  private smoothInferMs = 8
  private filterBanks: [PoseLandmarkFilterBank, PoseLandmarkFilterBank] = [
    new PoseLandmarkFilterBank(),
    new PoseLandmarkFilterBank(),
  ]
  private handFilterL = new HandLandmarkFilterBank()
  private handFilterR = new HandLandmarkFilterBank()
  private lastValidPoses: TrackedPose[] = []
  private lastValidTime = -Infinity
  private lastLeftHand: { lm: PoseLandmark[]; world: PoseLandmark[]; time: number } | null = null
  private lastRightHand: { lm: PoseLandmark[]; world: PoseLandmark[]; time: number } | null = null
  private highIntensityCombat = false

  public onPoses: ((poses: TrackedPose[], now: number, width: number, height: number) => void) | null =
    null
  public onError: ((error: unknown) => void) | null = null

  /** 激烈肉搏期间优先保证 3D 渲染流畅度 */
  public setHighIntensityCombat(active: boolean) {
    this.highIntensityCombat = active
  }

  public async start(video: HTMLVideoElement, maxPoses: 1 | 2 = 1): Promise<void> {
    if (!video) throw new Error('Video element unavailable')
    const session = ++this.session
    this.filterBanks[0].reset()
    this.filterBanks[1].reset()
    this.handFilterL.reset()
    this.handFilterR.reset()
    this.lastValidPoses = []
    this.lastValidTime = -Infinity
    this.lastLeftHand = null
    this.lastRightHand = null
    this.lastInferAt = -Infinity
    this.smoothInferMs = 8

    const isPortraitViewport =
      typeof window !== 'undefined' && window.innerHeight > window.innerWidth
    // 480x360 @ 30fps 足以喂饱 pose_landmarker_lite(256x256)，大幅减轻视频上传与 GPU 争抢
    const idealW = isPortraitViewport ? 360 : 480
    const idealH = isPortraitViewport ? 480 : 360

    const openCameraStream = async (): Promise<MediaStream> => {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'user' },
            width: { ideal: idealW, max: 640 },
            height: { ideal: idealH, max: 480 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        })
      } catch {
        return await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        })
      }
    }

    const [{ vision, fileset }, stream] = await Promise.all([
      loadVisionRuntime(),
      openCameraStream(),
    ])

    if (session !== this.session) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    const baseOpts = {
      runningMode: 'VIDEO',
      numPoses: maxPoses,
      minPoseDetectionConfidence: 0.34,
      minPosePresenceConfidence: 0.34,
      minTrackingConfidence: 0.34,
    }

    const createPose = async () => {
      try {
        return await vision.PoseLandmarker.createFromOptions(fileset, {
          ...baseOpts,
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
        })
      } catch {
        return await vision.PoseLandmarker.createFromOptions(fileset, {
          ...baseOpts,
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
        })
      }
    }

    // 停用昂贵的第二套 HandLandmarker 模型，消除双模型同步阻塞与 WebGL 管线卡顿
    const landmarker = await createPose()
    const handLandmarker: HandLandmarkerLike | null = null

    if (session !== this.session) {
      landmarker.close()
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    this.landmarker = landmarker
    this.handLandmarker = handLandmarker
    this.stream = stream
    video.srcObject = stream
    await video.play()
    if (session !== this.session) return

    this.detectOnce(video)

    const loop = () => {
      if (session !== this.session) return
      this.rafId = requestAnimationFrame(loop)
      if (!this.landmarker || video.readyState < 2) return
      if (video.currentTime === this.lastVideoTime) return
      const now = performance.now()
      // 动态推理间隔预算：保证单帧 AI 耗时绝不压死 WebGL 渲染主循环
      const baseFloor = this.highIntensityCombat ? 34 : 30
      const budgetInterval = Math.min(85, Math.max(baseFloor, this.smoothInferMs * 2.25))
      if (now - this.lastInferAt < budgetInterval) return
      this.lastVideoTime = video.currentTime
      this.lastInferAt = now
      try {
        this.detectOnce(video)
      } catch (err) {
        this.stop(video)
        this.onError?.(err)
      }
    }
    this.rafId = requestAnimationFrame(loop)
  }

  private detectOnce(video: HTMLVideoElement) {
    const lm = this.landmarker
    if (!lm || video.videoWidth <= 0 || video.videoHeight <= 0) return
    const now = performance.now()
    const ts = Math.max(now, this.lastDetectTimestamp + 1)
    this.lastDetectTimestamp = ts

    const res = lm.detectForVideo(video, ts)
    const inferMs = performance.now() - now
    this.smoothInferMs = this.smoothInferMs * 0.78 + inferMs * 0.22
    const lmSets = res.landmarks ?? []
    const worldSets = res.worldLandmarks ?? []
    const rawPoses: TrackedPose[] = []

    for (let i = 0; i < lmSets.length; i++) {
      const raw = lmSets[i]!
      if (raw.length < 33) continue
      const landmarks: PoseLandmark[] = raw.map((p) => ({
        x: p.x,
        y: p.y,
        z: p.z ?? 0,
        visibility: p.visibility ?? 1,
      }))
      const worldRaw = worldSets[i] ?? []
      const worldLandmarks: PoseLandmark[] =
        worldRaw.length >= 33
          ? worldRaw.map((p, idx) => ({
              x: p.x,
              y: p.y,
              z: p.z ?? 0,
              visibility: p.visibility ?? landmarks[idx]!.visibility,
            }))
          : []
      const ls = raw[11]!
      const rs = raw[12]!
      const mirroredCenterX = 1 - (ls.x + rs.x) * 0.5
      rawPoses.push({ landmarks, worldLandmarks, mirroredCenterX })
    }

    rawPoses.sort((a, b) => a.mirroredCenterX - b.mirroredCenterX)

    if (rawPoses.length === 0) {
      if (this.lastValidPoses.length > 0 && now - this.lastValidTime <= 180) {
        this.onPoses?.(this.lastValidPoses, now, video.videoWidth, video.videoHeight)
        return
      }
      this.onPoses?.([], now, video.videoWidth, video.videoHeight)
      return
    }

    const filteredPoses: TrackedPose[] = rawPoses.map((pose, idx) => {
      const bank = this.filterBanks[Math.min(idx, 1)]!
      const smoothed = bank.apply(pose.landmarks, pose.worldLandmarks, now)
      const ls = smoothed.landmarks[11]!
      const rs = smoothed.landmarks[12]!
      return {
        landmarks: smoothed.landmarks,
        worldLandmarks: smoothed.worldLandmarks,
        mirroredCenterX: 1 - (ls.x + rs.x) * 0.5,
      }
    })

    this.lastValidPoses = filteredPoses
    this.lastValidTime = now
    this.onPoses?.(filteredPoses, now, video.videoWidth, video.videoHeight)
  }

  public stop(video: HTMLVideoElement | null) {
    this.session++
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.lastVideoTime = -1
    this.lastValidPoses = []
    this.lastLeftHand = null
    this.lastRightHand = null
    this.filterBanks[0].reset()
    this.filterBanks[1].reset()
    this.handFilterL.reset()
    this.handFilterR.reset()
    if (this.landmarker) {
      try {
        this.landmarker.close()
      } catch {
        // 忽略释放阶段的内部上下文异常
      }
      this.landmarker = null
    }
    if (this.handLandmarker) {
      try {
        this.handLandmarker.close()
      } catch {
        // 忽略释放阶段的内部上下文异常
      }
      this.handLandmarker = null
    }
    if (this.stream) {
      this.stream.getTracks().forEach((tr) => tr.stop())
      this.stream = null
    }
    if (video) {
      video.srcObject = null
    }
  }
}

const TACTICAL_LINKS: readonly [number, number][] = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
]

const HAND_TACTICAL_LINKS: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
]

export interface TacticalRadarMeta {
  activeCue?: GestureActiveCue
  distanceHint?: DistanceHint
  chargeProgress?: number
}

/**
 * 在镜像摄像头画布上绘制智能防卫队战术骨骼雷达：
 * - 站位最佳安全框与偏心警示
 * - 实时肢体高亮反馈（出拳达标拳头金环爆闪、防御双臂亮青蓝盾光、L 字光线高亮光带、深蹲/起跳方向脉冲）
 */
export function drawTacticalSkeleton(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  poses: readonly (PoseLandmark[] | null | undefined)[],
  showSkeleton = true,
  splitDivider = false,
  hands?: readonly (PoseLandmark[] | null | undefined)[],
  meta?: TacticalRadarMeta,
) {
  ctx.clearRect(0, 0, width, height)

  const cue = meta?.activeCue ?? 'none'
  const distHint = meta?.distanceHint ?? 'ok'

  ctx.save()
  // 中轴虚线或双人分割线
  ctx.strokeStyle = splitDivider ? 'rgba(250, 204, 21, 0.52)' : 'rgba(56, 232, 255, 0.24)'
  ctx.lineWidth = splitDivider ? 1.5 : 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(width * 0.5, 0)
  ctx.lineTo(width * 0.5, height)
  ctx.stroke()
  ctx.setLineDash([])

  // 单人模式绘制四角站位校准框（距离偏近/偏远/偏离时切琥珀警示色）
  if (!splitDivider) {
    const frameColor =
      distHint === 'ok'
        ? 'rgba(56, 232, 255, 0.36)'
        : distHint === 'off-center'
          ? 'rgba(250, 204, 21, 0.72)'
          : 'rgba(251, 146, 60, 0.78)'
    const padX = width * 0.14
    const padY = height * 0.08
    const corner = Math.min(width, height) * 0.08
    ctx.strokeStyle = frameColor
    ctx.lineWidth = 1.6
    const corners: [number, number, number, number][] = [
      [padX, padY, 1, 1],
      [width - padX, padY, -1, 1],
      [padX, height - padY, 1, -1],
      [width - padX, height - padY, -1, -1],
    ]
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath()
      ctx.moveTo(cx + sx * corner, cy)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx, cy + sy * corner)
      ctx.stroke()
    }
  }
  ctx.restore()

  if (!showSkeleton) return

  const palette = [
    { bone: '#38e8ff', joint: '#e0f7ff', strike: '#facc15' },
    { bone: '#fb923c', joint: '#ffedd5', strike: '#38e8ff' },
  ]

  ctx.save()
  ctx.translate(width, 0)
  ctx.scale(-1, 1)

  poses.forEach((lms, slotIdx) => {
    if (!lms || lms.length < 29) return
    const theme = palette[slotIdx % palette.length]!

    const isPrimary = slotIdx === 0
    const highlightArms =
      isPrimary &&
      (cue === 'guard' ||
        cue === 'beam' ||
        cue === 'spread' ||
        cue === 'transform' ||
        cue === 'disc')
    const armHighlightColor =
      cue === 'guard'
        ? '#38bdf8'
        : cue === 'beam' || cue === 'spread'
          ? '#fde047'
          : cue === 'transform'
            ? '#f472b6'
            : '#67e8f9'

    ctx.lineCap = 'round'
    for (const [aIdx, bIdx] of TACTICAL_LINKS) {
      const a = lms[aIdx]
      const b = lms[bIdx]
      if (!a || !b || (a.visibility ?? 1) < 0.3 || (b.visibility ?? 1) < 0.3) continue
      const isArmSeg =
        (aIdx === 11 && bIdx === 13) ||
        (aIdx === 13 && bIdx === 15) ||
        (aIdx === 12 && bIdx === 14) ||
        (aIdx === 14 && bIdx === 16)
      const isPunchSeg =
        isPrimary &&
        ((cue === 'punch-l' && (aIdx === 11 || aIdx === 13) && bIdx <= 15) ||
          (cue === 'punch-r' && (aIdx === 12 || aIdx === 14) && bIdx <= 16))
      const isKickSeg = isPrimary && cue === 'kick' && aIdx >= 23

      const isActiveSeg = isPunchSeg || isKickSeg || (highlightArms && isArmSeg)
      const segColor = isPunchSeg || isKickSeg
        ? '#fde047'
        : highlightArms && isArmSeg
          ? armHighlightColor
          : isPrimary && (cue === 'crouch' || cue === 'jump')
            ? '#4ade80'
            : theme.bone

      // 零 shadowBlur 双层轻量描边：模拟荧光辉光同时避免 Canvas2D 软光栅高斯模糊卡顿
      if (isActiveSeg) {
        ctx.strokeStyle = segColor
        ctx.globalAlpha = 0.28
        ctx.lineWidth = 8.5
        ctx.beginPath()
        ctx.moveTo(a.x * width, a.y * height)
        ctx.lineTo(b.x * width, b.y * height)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      ctx.strokeStyle = segColor
      ctx.lineWidth = isActiveSeg ? 3.6 : 2.2
      ctx.beginPath()
      ctx.moveTo(a.x * width, a.y * height)
      ctx.lineTo(b.x * width, b.y * height)
      ctx.stroke()
    }

    const nose = lms[0]
    if (nose && (nose.visibility ?? 1) >= 0.32) {
      ctx.beginPath()
      ctx.strokeStyle = theme.joint
      ctx.lineWidth = 1.6
      ctx.arc(nose.x * width, nose.y * height, 6.2, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.fillStyle = theme.joint
    for (const idx of [11, 12, 13, 14, 23, 24, 25, 26]) {
      const p = lms[idx]
      if (!p || (p.visibility ?? 1) < 0.32) continue
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }

    // 拳脚能量锚点：出招瞬间在对应手腕/脚踝爆出大号荧光冲击环（零 shadowBlur）
    for (const idx of [15, 16, 27, 28]) {
      const p = lms[idx]
      if (!p || (p.visibility ?? 1) < 0.28) continue
      const burst =
        isPrimary &&
        ((cue === 'punch-l' && idx === 15) ||
          (cue === 'punch-r' && idx === 16) ||
          (cue === 'kick' && (idx === 27 || idx === 28)))
      if (burst) {
        ctx.fillStyle = 'rgba(253, 224, 71, 0.32)'
        ctx.beginPath()
        ctx.arc(p.x * width, p.y * height, 11.5, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = burst ? '#ffffff' : theme.strike
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, burst ? 5.8 : 3.8, 0, Math.PI * 2)
      ctx.fill()
      if (burst) {
        ctx.strokeStyle = '#fde047'
        ctx.lineWidth = 2.0
        ctx.beginPath()
        ctx.arc(p.x * width, p.y * height, 13, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // 防御/光线蓄力进度环直接绘制在胸口中心
    if (isPrimary && (cue === 'guard' || cue === 'beam' || cue === 'spread')) {
      const ls = lms[11]
      const rs = lms[12]
      if (ls && rs) {
        const cx = ((ls.x + rs.x) * 0.5) * width
        const cy = ((ls.y + rs.y) * 0.5 + 0.06) * height
        const progress = Math.max(0.15, Math.min(1, meta?.chargeProgress ?? 1))
        ctx.strokeStyle = armHighlightColor
        ctx.lineWidth = 2.6
        ctx.beginPath()
        ctx.arc(cx, cy, 18, -Math.PI * 0.5, -Math.PI * 0.5 + Math.PI * 2 * progress)
        ctx.stroke()
      }
    }
  })

  // 若存在手部精细关键点则轻量绘制
  if (hands && hands.length > 0) {
    for (const hand of hands) {
      if (!hand || hand.length < 21) continue
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      for (const [aIdx, bIdx] of HAND_TACTICAL_LINKS) {
        const a = hand[aIdx]
        const b = hand[bIdx]
        if (!a || !b) continue
        ctx.moveTo(a.x * width, a.y * height)
        ctx.lineTo(b.x * width, b.y * height)
      }
      ctx.stroke()

      ctx.fillStyle = '#fef08a'
      for (const tipIdx of [4, 8, 12, 16, 20]) {
        const p = hand[tipIdx]
        if (!p) continue
        ctx.beginPath()
        ctx.arc(p.x * width, p.y * height, 2.0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  ctx.restore()
}
