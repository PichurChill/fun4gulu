import type { PoseLandmark } from './types'

export interface TrackedPose {
  landmarks: PoseLandmark[]
  worldLandmarks: PoseLandmark[]
  /** 镜像画面下的水平中心 [0, 1]，0.5 为正中央，越小越靠左 */
  mirroredCenterX: number
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
 * 统一现代姿态追踪器（单人 / 双人共用 MediaPipe Tasks Vision PoseLandmarker）
 */
export class UltraPoseTracker {
  private landmarker: PoseLandmarkerLike | null = null
  private stream: MediaStream | null = null
  private session = 0
  private rafId = 0
  private lastVideoTime = -1
  private lastDetectTimestamp = 0

  public onPoses: ((poses: TrackedPose[], now: number, width: number, height: number) => void) | null =
    null
  public onError: ((error: unknown) => void) | null = null

  public async start(video: HTMLVideoElement, maxPoses: 1 | 2 = 1): Promise<void> {
    if (!video) throw new Error('Video element unavailable')
    const session = ++this.session

    const [{ vision, fileset }, stream] = await Promise.all([
      loadVisionRuntime(),
      navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: maxPoses === 2 ? 640 : 560 },
          height: { ideal: maxPoses === 2 ? 480 : 420 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      }),
    ])

    if (session !== this.session) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    const baseOpts = {
      runningMode: 'VIDEO',
      numPoses: maxPoses,
      minPoseDetectionConfidence: 0.45,
      minPosePresenceConfidence: 0.45,
      minTrackingConfidence: 0.45,
    }

    let landmarker: PoseLandmarkerLike
    try {
      landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        ...baseOpts,
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
      })
    } catch {
      landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        ...baseOpts,
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
      })
    }

    if (session !== this.session) {
      landmarker.close()
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    this.landmarker = landmarker
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
    const poses: TrackedPose[] = []

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
      poses.push({ landmarks, worldLandmarks, mirroredCenterX })
    }

    poses.sort((a, b) => a.mirroredCenterX - b.mirroredCenterX)
    this.onPoses?.(poses, now, video.videoWidth, video.videoHeight)
  }

  public stop(video: HTMLVideoElement | null) {
    this.session++
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.lastVideoTime = -1
    if (this.landmarker) {
      try {
        this.landmarker.close()
      } catch {
        // 忽略释放阶段的内部上下文异常
      }
      this.landmarker = null
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

/**
 * 在镜像摄像头画布上绘制特摄防卫队战术骨骼雷达与拳脚能量锚点
 */
export function drawTacticalSkeleton(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  poses: readonly (PoseLandmark[] | null | undefined)[],
  showSkeleton = true,
  splitDivider = false,
) {
  ctx.clearRect(0, 0, width, height)

  // 绘制战术中心参考虚线
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
  // 水平镜像以严格对齐镜像视频画面
  ctx.translate(width, 0)
  ctx.scale(-1, 1)

  poses.forEach((lms, slotIdx) => {
    if (!lms || lms.length < 29) return
    const theme = palette[slotIdx % palette.length]!

    // 骨骼连线
    ctx.strokeStyle = theme.bone
    ctx.lineWidth = 2.4
    ctx.lineCap = 'round'
    ctx.shadowColor = theme.bone
    ctx.shadowBlur = 6
    ctx.beginPath()
    for (const [aIdx, bIdx] of TACTICAL_LINKS) {
      const a = lms[aIdx]
      const b = lms[bIdx]
      if (!a || !b || (a.visibility ?? 1) < 0.32 || (b.visibility ?? 1) < 0.32) continue
      ctx.moveTo(a.x * width, a.y * height)
      ctx.lineTo(b.x * width, b.y * height)
    }
    ctx.stroke()

    // 头部战术定位环
    const nose = lms[0]
    if (nose && (nose.visibility ?? 1) >= 0.35) {
      ctx.beginPath()
      ctx.strokeStyle = theme.joint
      ctx.lineWidth = 1.6
      ctx.arc(nose.x * width, nose.y * height, 6.5, 0, Math.PI * 2)
      ctx.stroke()
    }

    // 常规关节锚点
    ctx.shadowBlur = 0
    ctx.fillStyle = theme.joint
    for (const idx of [11, 12, 13, 14, 23, 24, 25, 26]) {
      const p = lms[idx]
      if (!p || (p.visibility ?? 1) < 0.35) continue
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, 2.6, 0, Math.PI * 2)
      ctx.fill()
    }

    // 双拳与双脚高能打击点高亮
    ctx.fillStyle = theme.strike
    ctx.shadowColor = theme.strike
    ctx.shadowBlur = 8
    for (const idx of [15, 16, 27, 28]) {
      const p = lms[idx]
      if (!p || (p.visibility ?? 1) < 0.3) continue
      ctx.beginPath()
      ctx.arc(p.x * width, p.y * height, 4.2, 0, Math.PI * 2)
      ctx.fill()
    }
  })

  ctx.restore()
}
