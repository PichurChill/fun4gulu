import type { PoseLandmark } from './types'

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
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

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
 * 静止时强抑抖动，高速挥拳/踢腿/闪避时瞬间拉高截止频率，兼顾极致稳定与零延迟跟手。
 */
class OneEuroScalar {
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev: number | null = null

  constructor(
    private readonly minCutoff: number,
    private readonly beta: number,
    private readonly dCutoff = 1.0,
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
      // 四肢末端（肘、腕、指、膝、踝）给更高的动态响应系数 beta，确保快速挥拳与踢腿零拖影
      const isLimb = (i >= 13 && i <= 22) || (i >= 25 && i <= 32)
      const minCutoff2D = isLimb ? 2.4 : 1.5
      const beta2D = isLimb ? 22.0 : 9.0
      const minCutoff3D = isLimb ? 2.2 : 1.35
      const beta3D = isLimb ? 16.0 : 7.5
      this.filters2D.push([
        new OneEuroScalar(minCutoff2D, beta2D),
        new OneEuroScalar(minCutoff2D, beta2D),
        new OneEuroScalar(minCutoff2D * 0.75, beta2D * 0.65),
      ])
      this.filters3D.push([
        new OneEuroScalar(minCutoff3D, beta3D),
        new OneEuroScalar(minCutoff3D, beta3D),
        new OneEuroScalar(minCutoff3D * 0.75, beta3D * 0.6),
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

/** 单手 21 点 2D+3D 关节一欧元滤波组（静手极稳、甩指零拖影） */
class HandLandmarkFilterBank {
  private filters2D: [OneEuroScalar, OneEuroScalar, OneEuroScalar][] = []
  private filters3D: [OneEuroScalar, OneEuroScalar, OneEuroScalar][] = []
  private lastT = -Infinity

  constructor() {
    for (let i = 0; i < 21; i++) {
      const isTip = i === 4 || i === 8 || i === 12 || i === 16 || i === 20
      const minCut = isTip ? 2.8 : 2.2
      const beta = isTip ? 26.0 : 18.0
      this.filters2D.push([
        new OneEuroScalar(minCut, beta),
        new OneEuroScalar(minCut, beta),
        new OneEuroScalar(minCut * 0.8, beta * 0.7),
      ])
      this.filters3D.push([
        new OneEuroScalar(minCut, beta * 0.85),
        new OneEuroScalar(minCut, beta * 0.85),
        new OneEuroScalar(minCut * 0.8, beta * 0.65),
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
 * 统一现代全身+精细双手姿态追踪器：
 * - MediaPipe PoseLandmarker (33 点全身 3D) + HandLandmarker (双手 42 点精细手指 3D) 协同运行
 * - One-Euro 自适应去抖 + 按推理耗时动态自适应帧率预算，兼顾丝滑 60fps 与独立十指实时捕捉
 */
export class UltraPoseTracker {
  private landmarker: PoseLandmarkerLike | null = null
  private handLandmarker: HandLandmarkerLike | null = null
  private stream: MediaStream | null = null
  private session = 0
  private rafId = 0
  private lastVideoTime = -1
  private lastDetectTimestamp = 0
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
  private lastHandInferAt = -Infinity
  private handMinIntervalMs = 0

  public onPoses: ((poses: TrackedPose[], now: number, width: number, height: number) => void) | null =
    null
  public onError: ((error: unknown) => void) | null = null

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
    this.lastHandInferAt = -Infinity
    this.handMinIntervalMs = 0

    const isPortraitViewport =
      typeof window !== 'undefined' && window.innerHeight > window.innerWidth
    const idealW = isPortraitViewport ? 480 : 640
    const idealH = isPortraitViewport ? 640 : 480

    const openCameraStream = async (): Promise<MediaStream> => {
      try {
        return await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'user' },
            width: { ideal: idealW },
            height: { ideal: idealH },
            frameRate: { ideal: 60, min: 24 },
          },
          audio: false,
        })
      } catch {
        // 兼容部分移动浏览器不接受高帧率或特定分辨率约束的情况
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
      minPoseDetectionConfidence: 0.38,
      minPosePresenceConfidence: 0.38,
      minTrackingConfidence: 0.38,
    }

    let landmarker: PoseLandmarkerLike
    let handLandmarker: HandLandmarkerLike | null = null

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

    const createHand = async (): Promise<HandLandmarkerLike | null> => {
      // 单人模式并行开启双手 21 点精细手指追踪；双人同屏关闭以保持满帧率
      if (maxPoses !== 1 || !vision.HandLandmarker) return null
      const handOpts = {
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.42,
        minHandPresenceConfidence: 0.42,
        minTrackingConfidence: 0.42,
      }
      try {
        return await vision.HandLandmarker.createFromOptions(fileset, {
          ...handOpts,
          baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        })
      } catch {
        try {
          return await vision.HandLandmarker.createFromOptions(fileset, {
            ...handOpts,
            baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'CPU' },
          })
        } catch (err) {
          console.warn('[UltraPoseTracker] HandLandmarker 初始化失败，退回纯全身追踪:', err)
          return null
        }
      }
    }

    ;[landmarker, handLandmarker] = await Promise.all([createPose(), createHand()])

    if (session !== this.session) {
      landmarker.close()
      handLandmarker?.close()
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    this.landmarker = landmarker
    this.handLandmarker = handLandmarker
    this.stream = stream
    video.srcObject = stream
    await video.play()
    if (session !== this.session) return

    // 首帧预热推理，确保进入战斗前模型管线已就绪
    this.detectOnce(video)

    const loop = () => {
      if (session !== this.session) return
      this.rafId = requestAnimationFrame(loop)
      if (!this.landmarker || video.readyState < 2) return
      if (video.currentTime === this.lastVideoTime) return
      this.lastVideoTime = video.currentTime
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
    // Tasks Vision 要求单调递增时间戳
    const ts = Math.max(now, this.lastDetectTimestamp + 1)
    this.lastDetectTimestamp = ts

    const res = lm.detectForVideo(video, ts)
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
      // 快速动作瞬时遮挡（<= 160ms）保留上一帧平滑姿态，避免角色突然弹回僵直
      if (this.lastValidPoses.length > 0 && now - this.lastValidTime <= 160) {
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

    // 单人模式下协同追踪双手 21 点精细手指，并通过手腕 2D 最近邻精准绑定至左/右手（绝不串手）
    if (this.handLandmarker && filteredPoses.length === 1) {
      const primary = filteredPoses[0]!
      if (now - this.lastHandInferAt >= this.handMinIntervalMs) {
        this.lastHandInferAt = now
        const t0 = performance.now()
        try {
          const handRes = this.handLandmarker.detectForVideo(video, ts)
          const inferMs = performance.now() - t0
          // 按实测耗时自适应推理周期：GPU 高速（<= 10ms）全帧率 60Hz，较慢设备自动退至 ~28Hz 绝不卡顿
          this.handMinIntervalMs = inferMs > 11 ? 34 : 0

          const hLmSets = handRes.landmarks ?? []
          const hWorldSets = handRes.worldLandmarks ?? []
          const poseLW = primary.landmarks[15]
          const poseRW = primary.landmarks[16]

          let matchedL: { lm: PoseLandmark[]; world: PoseLandmark[]; dist: number } | null = null
          let matchedR: { lm: PoseLandmark[]; world: PoseLandmark[]; dist: number } | null = null

          for (let h = 0; h < hLmSets.length; h++) {
            const rawH = hLmSets[h]
            if (!rawH || rawH.length < 21) continue
            const wrist = rawH[0]!
            const distL =
              poseLW && (poseLW.visibility ?? 1) > 0.15
                ? Math.hypot(wrist.x - poseLW.x, wrist.y - poseLW.y)
                : Infinity
            const distR =
              poseRW && (poseRW.visibility ?? 1) > 0.15
                ? Math.hypot(wrist.x - poseRW.x, wrist.y - poseRW.y)
                : Infinity

            const h2d: PoseLandmark[] = rawH.map((p) => ({
              x: p.x,
              y: p.y,
              z: p.z ?? 0,
              visibility: 1,
            }))
            const wRaw = hWorldSets[h] ?? []
            const h3d: PoseLandmark[] =
              wRaw.length >= 21
                ? wRaw.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0, visibility: 1 }))
                : []

            const assignLeft = distL <= distR
            const bestDist = assignLeft ? distL : distR
            if (bestDist > 0.28) continue
            if (assignLeft) {
              if (!matchedL || bestDist < matchedL.dist) {
                matchedL = { lm: h2d, world: h3d, dist: bestDist }
              }
            } else {
              if (!matchedR || bestDist < matchedR.dist) {
                matchedR = { lm: h2d, world: h3d, dist: bestDist }
              }
            }
          }

          if (matchedL) {
            const fl = this.handFilterL.apply(matchedL.lm, matchedL.world, now)
            this.lastLeftHand = { lm: fl.landmarks, world: fl.worldLandmarks, time: now }
          }
          if (matchedR) {
            const fr = this.handFilterR.apply(matchedR.lm, matchedR.world, now)
            this.lastRightHand = { lm: fr.landmarks, world: fr.worldLandmarks, time: now }
          }
        } catch {
          this.handMinIntervalMs = 50
        }
      }

      if (this.lastLeftHand && now - this.lastLeftHand.time <= 220) {
        primary.leftHandLandmarks = this.lastLeftHand.lm
        primary.leftHandWorldLandmarks = this.lastLeftHand.world
      }
      if (this.lastRightHand && now - this.lastRightHand.time <= 220) {
        primary.rightHandLandmarks = this.lastRightHand.lm
        primary.rightHandWorldLandmarks = this.lastRightHand.world
      }
    }

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

/**
 * 在镜像摄像头画布上绘制特摄防卫队战术骨骼雷达、拳脚能量锚点与双手 21 点精细指骨
 */
export function drawTacticalSkeleton(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  poses: readonly (PoseLandmark[] | null | undefined)[],
  showSkeleton = true,
  splitDivider = false,
  hands?: readonly (PoseLandmark[] | null | undefined)[],
) {
  ctx.clearRect(0, 0, width, height)

  ctx.save()
  ctx.strokeStyle = splitDivider ? 'rgba(250, 204, 21, 0.45)' : 'rgba(56, 232, 255, 0.25)'
  ctx.lineWidth = 1
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(width * 0.5, 0)
  ctx.lineTo(width * 0.5, height)
  ctx.stroke()
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

    ctx.strokeStyle = theme.bone
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.shadowColor = theme.bone
    ctx.shadowBlur = 6
    ctx.beginPath()
    for (const [aIdx, bIdx] of TACTICAL_LINKS) {
      const a = lms[aIdx]
      const b = lms[bIdx]
      if (!a || !b || (a.visibility ?? 1) < 0.3 || (b.visibility ?? 1) < 0.3) continue
      ctx.moveTo(a.x * width, a.y * height)
      ctx.lineTo(b.x * width, b.y * height)
    }
    ctx.stroke()

    const nose = lms[0]
    if (nose && (nose.visibility ?? 1) >= 0.32) {
      ctx.beginPath()
      ctx.strokeStyle = theme.joint
      ctx.lineWidth = 1.6
      ctx.arc(nose.x * width, nose.y * height, 6.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    ctx.shadowBlur = 0
    ctx.fillStyle = theme.joint
    for (const idx of [11, 12, 13, 14, 23, 24, 25, 26]) {
      const p = lms[idx]
      if (!p || (p.visibility ?? 1) < 0.32) continue
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, 2.6, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = theme.strike
    ctx.shadowColor = theme.strike
    ctx.shadowBlur = 8
    for (const idx of [15, 16, 27, 28]) {
      const p = lms[idx]
      if (!p || (p.visibility ?? 1) < 0.28) continue
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, 4.2, 0, Math.PI * 2)
      ctx.fill()
    }
  })

  // 绘制 21 点精细双手骨架与五指指尖荧光点，让玩家实时直观看到十指捕捉反馈
  if (hands && hands.length > 0) {
    for (const hand of hands) {
      if (!hand || hand.length < 21) continue
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.9)'
      ctx.lineWidth = 1.5
      ctx.shadowColor = '#facc15'
      ctx.shadowBlur = 4
      ctx.beginPath()
      for (const [aIdx, bIdx] of HAND_TACTICAL_LINKS) {
        const a = hand[aIdx]
        const b = hand[bIdx]
        if (!a || !b) continue
        ctx.moveTo(a.x * width, a.y * height)
        ctx.lineTo(b.x * width, b.y * height)
      }
      ctx.stroke()

      ctx.shadowBlur = 0
      ctx.fillStyle = '#fef08a'
      for (const tipIdx of [4, 8, 12, 16, 20]) {
        const p = hand[tipIdx]
        if (!p) continue
        ctx.beginPath()
        ctx.arc(p.x * width, p.y * height, 2.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  ctx.restore()
}
