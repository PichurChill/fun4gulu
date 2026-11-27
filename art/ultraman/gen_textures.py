"""
生成四位奥特曼（迪迦 / 赛罗 / 戴拿 / 泽塔）影视级 PBR 全通道纹理：
- 迪迦：1996 权藤版深皇室紫 / 浓正红 / 丝缎银校色 + 色块拼缝凹槽法线 + 潜水料微肌理 + 2K ORM + 1K 钻石蜂窝复眼与切面计时器
- 赛罗 / 戴拿 / 泽塔：2K 超分锐化主贴图 + 精准金属/皮套分区 Metallic-Roughness + 增强微肌理法线 + 1K 高锐度自发光
"""
import os
import math
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance
from scipy.ndimage import gaussian_filter, sobel, binary_dilation, binary_erosion

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORK_DIR = os.environ.get("ULTRAMAN_ART_WORK_DIR", os.path.join(BASE_DIR, "work"))
OUT_TEX = os.path.join(WORK_DIR, "pbr_textures")
os.makedirs(OUT_TEX, exist_ok=True)


def height_to_normal(height_map: np.ndarray, strength: float = 2.0) -> np.ndarray:
    """将单通道浮点高度图转为标准切线空间 RGB 法线图 (uint8, OpenGL/glTF +Y)"""
    dx = sobel(height_map, axis=1, mode="wrap") * strength
    dy = sobel(height_map, axis=0, mode="wrap") * strength
    nx = -dx
    ny = dy  # glTF / OpenGL 法线 +Y 向上，而图像坐标 y 向下
    nz = np.ones_like(height_map)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    nx *= inv_len
    ny *= inv_len
    nz *= inv_len
    rgb = np.stack([(nx * 0.5 + 0.5), (ny * 0.5 + 0.5), (nz * 0.5 + 0.5)], axis=-1)
    return np.clip(rgb * 255.0, 0, 255).astype(np.uint8)


def tileable_micro_grain(size: int, seed: int = 42, scale_a: float = 1.0) -> np.ndarray:
    """生成细腻无缝特摄潜水料微颗粒纹理（无视觉噪点，仅提供微弱真实高光漫散射）"""
    rng = np.random.default_rng(seed)
    n1 = rng.standard_normal((size, size)).astype(np.float32)
    n1 = gaussian_filter(n1, sigma=0.85 * scale_a, mode="wrap")
    n2 = rng.standard_normal((size // 2, size // 2)).astype(np.float32)
    n2 = gaussian_filter(n2, sigma=1.1, mode="wrap")
    n2 = np.array(Image.fromarray(n2).resize((size, size), Image.Resampling.BILINEAR), dtype=np.float32)
    g = n1 * 0.65 + n2 * 0.35
    g = g / (np.std(g) + 1e-6)
    return g


def build_tiga_textures():
    print("正在生成迪迦奥特曼 2K 影视级全通道 PBR 贴图...")
    orig_path = os.path.join(WORK_DIR, "inspect_detail/orig_tiga_tiga-pbr-color.png")
    img = Image.open(orig_path).convert("RGB")
    arr = np.asarray(img, dtype=np.float32) / 255.0
    h, w, _ = arr.shape
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]

    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    sat = max_c - min_c

    # 精准分离 UV 中的 4 大像素区：背景深灰 / 银白战衣 / 紫色区 / 红色区
    is_bg = (sat < 0.04) & (max_c < 0.45)
    is_silver = (~is_bg) & (sat < 0.08) & (max_c >= 0.65)
    is_purple = (~is_bg) & (b > g + 0.08) & (b > r * 0.9)
    is_red = (~is_bg) & (r > g + 0.15) & (r > b + 0.08)

    # 1. 1996 权藤版迪迦复合型特摄标准校色（保留抗锯齿边界的平滑权重）
    out = arr.copy()
    # 柔和掩膜便于边界抗锯齿平滑融合
    w_purple = np.clip((b - g - 0.04) / 0.14, 0.0, 1.0) * (~is_bg).astype(np.float32)
    w_red = np.clip((r - np.maximum(g, b) - 0.08) / 0.18, 0.0, 1.0) * (~is_bg).astype(np.float32)
    w_silver = np.clip((max_c - 0.58) / 0.18, 0.0, 1.0) * np.clip((0.10 - sat) / 0.08, 0.0, 1.0)

    # 规范化三色权重（背景像素保持中灰避免贴图采样渗黑边）
    # 深邃皇室蓝紫 (兼顾 hero.ts 的 all-red 重映射条件: b > g+12 && b > r*0.52 && g < b*0.78)
    col_purple = np.array([0.19, 0.16, 0.49], dtype=np.float32)
    # 饱满特摄深正红 (兼顾 hero.ts 的 all-violet 重映射条件: r > g+22 && r > b+12)
    col_red = np.array([0.69, 0.11, 0.16], dtype=np.float32)
    # 高级冷钛珍珠银白
    col_silver = np.array([0.85, 0.88, 0.92], dtype=np.float32)

    w_sum = w_purple + w_red + w_silver
    valid = w_sum > 0.05
    wp = np.where(valid, w_purple / np.maximum(w_sum, 1e-5), 0.0)
    wr = np.where(valid, w_red / np.maximum(w_sum, 1e-5), 0.0)
    ws = np.where(valid, w_silver / np.maximum(w_sum, 1e-5), 0.0)

    recolored = (
        wp[:, :, None] * col_purple[None, None, :]
        + wr[:, :, None] * col_red[None, None, :]
        + ws[:, :, None] * col_silver[None, None, :]
    )
    out = np.where(valid[:, :, None], recolored, arr)

    # 2. 提取紫/红/银皮套裁片拼接缝线（特摄皮套灵魂细节！）
    # 色块标签图：0=bg, 1=silver, 2=purple, 3=red
    label = np.zeros((h, w), dtype=np.int32)
    label[is_silver] = 1
    label[is_purple] = 2
    label[is_red] = 3

    # 计算相邻色块交界（仅在有效战衣色块 1/2/3 之间，不把 UV 岛外沿误判为缝线）
    seam = np.zeros((h, w), dtype=np.float32)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (0, 2)):
        shifted = np.roll(np.roll(label, dy, axis=0), dx, axis=1)
        diff = (label > 0) & (shifted > 0) & (label != shifted)
        seam = np.maximum(seam, diff.astype(np.float32))

    # 缝线凹槽（中心下凹）+ 双侧微鼓滚边（裁片布料厚度）
    seam_groove = gaussian_filter(seam, sigma=1.6)
    seam_groove = np.clip(seam_groove * 2.4, 0.0, 1.0)
    seam_puff = gaussian_filter(seam, sigma=5.2) - seam_groove * 0.65
    seam_puff = np.clip(seam_puff * 1.8, 0.0, 1.0)

    # 细腻潜水料微颗粒纹理（极度细腻丝滑，绝不粗糙橘皮；银色区光滑丝缎，红紫区细腻微肌理）
    grain = tileable_micro_grain(h, seed=1996, scale_a=0.68)
    suit_mask = (label > 0).astype(np.float32)
    fabric_mask = ((label == 2) | (label == 3)).astype(np.float32)

    # 高度场合成：精细缝线凹槽 + 裁片两侧微隆滚边 + 丝滑潜水料微颗粒
    height_map = (
        -seam_groove * 0.34
        + seam_puff * 0.12
        + grain * (0.0055 * fabric_mask + 0.0028 * (suit_mask - fabric_mask))
    )
    normal_rgb = height_to_normal(height_map, strength=2.2)
    Image.fromarray(normal_rgb, "RGB").save(os.path.join(OUT_TEX, "tiga_suit_normal.png"))

    # 在主漫反射贴图上叠加极细腻的缝线暗影 AO（去噪点，丝滑饱满）
    ao = np.clip(1.0 - seam_groove * 0.22 + seam_puff * 0.03, 0.72, 1.02)
    albedo = np.clip(out * ao[:, :, None] + (grain[:, :, None] * 0.003 * fabric_mask[:, :, None]), 0.0, 1.0)
    Image.fromarray((albedo * 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, "tiga_suit_albedo.png"))

    # 3. glTF 标准 ORM 贴图：R=AO, G=Roughness, B=Metallic
    # 银色丝缎区：较高金属感(0.46)与丝滑反光(rough=0.28)；红紫特摄皮套：低金属感(0.08)半哑光丝滑(rough=0.40)
    roughness = (
        ws * 0.28
        + (wp + wr) * 0.40
        + (1.0 - np.clip(w_sum, 0.0, 1.0)) * 0.45
        + seam_groove * 0.20
        + grain * 0.008 * fabric_mask
    )
    metallic = ws * 0.46 + (wp + wr) * 0.08 - seam_groove * 0.16
    orm = np.stack([
        np.clip(ao, 0.0, 1.0),
        np.clip(roughness, 0.18, 0.85),
        np.clip(metallic, 0.0, 0.90),
    ], axis=-1)
    Image.fromarray((orm * 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, "tiga_suit_orm.png"))

    # 4. 头雕冷钛铝银 & 胸甲 24K 香槟金专用漫反射与微拉丝法线贴图 (512x512，确保 glTF 导出 100% 忠实保留金/银发色)
    m_grain = tileable_micro_grain(512, seed=2025, scale_a=0.85)
    # 细微金属拉丝方向性微纹
    brush = gaussian_filter(m_grain, sigma=(0.45, 2.8), mode="wrap")
    silver_norm = height_to_normal(brush * 0.008, strength=1.2)
    Image.fromarray(silver_norm, "RGB").save(os.path.join(OUT_TEX, "tiga_metal_normal.png"))

    silver_col = np.clip(
        np.array([0.82, 0.85, 0.89], dtype=np.float32)[None, None, :] + brush[:, :, None] * 0.012,
        0.0,
        1.0,
    )
    Image.fromarray((silver_col * 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, "tiga_silver_albedo.png"))

    # 24K 饱满香槟钛金（特摄原版迪迦胸甲金条，耀眼不发灰、不偏绿）
    gold_col = np.clip(
        np.array([0.96, 0.76, 0.26], dtype=np.float32)[None, None, :] + brush[:, :, None] * 0.018,
        0.0,
        1.0,
    )
    Image.fromarray((gold_col * 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, "tiga_gold_albedo.png"))

    # 5. 1024x1024 影视特摄级迪迦钻石蜂窝复眼贴图（漫反射 + 棱镜凸起法线 + 自发光）
    build_tiga_eye_textures(1024)

    # 6. 512x512 迪迦胸口宝石切面彩色计时器贴图（漫反射 + 多面切面法线）
    build_tiga_timer_textures(512)
    print("✓ 迪迦全套 2K PBR / 复眼 / 计时器贴图生成完成")


def build_tiga_eye_textures(size: int = 1024):
    """生成特摄真实皮套复眼：温润奶白暖金中心 + 柔和琥珀眼周 + 六角蜂窝光学钻石棱镜"""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    u = (x / (size - 1)) * 2.0 - 1.0  # [-1, 1]
    v = (y / (size - 1)) * 2.0 - 1.0
    rad = np.sqrt(u * u * 0.92 + v * v * 1.15)

    # 六角蜂窝光学晶格坐标（更柔和细腻的圆谷真实光学面罩质感，特写下剔透优雅）
    freq = 15.0
    sx = (x / size) * freq
    sy = (y / size) * freq * (2.0 / math.sqrt(3.0))
    # 六角网格最近中心距离
    q = sx
    r_hex = sy - 0.5 * sx
    # 轴向坐标取整求每格中心
    qf = np.round(q)
    rf = np.round(r_hex)
    sf = np.round(-q - r_hex)
    dq = np.abs(qf - q)
    dr = np.abs(rf - r_hex)
    ds = np.abs(sf - (-q - r_hex))
    cond1 = (dq > dr) & (dq > ds)
    cond2 = (~cond1) & (dr > ds)
    qf = np.where(cond1, -rf - sf, qf)
    rf = np.where(cond2, -qf - sf, rf)

    cx = qf
    cy = (rf + 0.5 * qf)
    dx = (sx - cx)
    dy = (sy - cy) * (math.sqrt(3.0) / 2.0)
    cell_dist = np.sqrt(dx * dx + dy * dy)  # 0=中心, ~0.5=六角棱边

    # 单颗钻石棱镜微凸高度（细腻通透，沟槽不过黑）
    facet_dome = np.clip(1.0 - (cell_dist / 0.54) ** 2.0, 0.0, 1.0)
    facet_groove = np.clip((cell_dist - 0.43) / 0.12, 0.0, 1.0)

    # 复眼主色：圆谷 1996 经典象牙暖奶金 (#FFF6D4 -> #E5C268)，温润神圣不发冷灰
    edge_t = np.clip((rad - 0.22) / 0.85, 0.0, 1.0)
    c_center = np.array([1.00, 0.96, 0.82], dtype=np.float32)
    c_edge = np.array([0.88, 0.72, 0.36], dtype=np.float32)
    base_col = c_center[None, None, :] * (1.0 - edge_t[:, :, None]) + c_edge[None, None, :] * edge_t[:, :, None]

    # 晶格沟槽细腻着色
    albedo = base_col * (0.91 + 0.09 * facet_dome[:, :, None] - 0.09 * facet_groove[:, :, None])
    rim_shadow = np.clip(1.0 - np.clip((rad - 0.84) / 0.20, 0.0, 1.0) * 0.36, 0.60, 1.0)
    albedo = np.clip(albedo * rim_shadow[:, :, None], 0.0, 1.0)
    Image.fromarray((albedo * 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, "tiga_eye_albedo.png"))

    # 自发光图：中心温暖通透、外缘柔和收光，兼顾璀璨神采与晶格清晰度
    emissive = albedo * (0.98 - 0.24 * edge_t[:, :, None]) * (0.92 + 0.08 * facet_dome[:, :, None])
    Image.fromarray((np.clip(emissive, 0.0, 1.0) * 255).astype(np.uint8), "RGB").save(
        os.path.join(OUT_TEX, "tiga_eye_emissive.png")
    )

    # 光学棱镜凸起法线贴图
    eye_norm = height_to_normal(facet_dome * 0.24, strength=1.7)
    Image.fromarray(eye_norm, "RGB").save(os.path.join(OUT_TEX, "tiga_eye_normal.png"))


def build_tiga_timer_textures(size: int = 512):
    """生成迪迦胸口多面宝石切割彩色计时器贴图（主色保持纯白/淡青灰以便引擎灵活染色冰蓝/危急红）"""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    u = (x / (size - 1)) * 2.0 - 1.0
    v = (y / (size - 1)) * 2.0 - 1.0
    r = np.sqrt(u * u + v * v)
    ang = np.arctan2(v, u)

    # 12 向放射宝石切割棱面 + 双层同心折射环
    spoke = np.abs(np.cos(ang * 6.0))
    ring = np.abs(np.cos(r * math.pi * 3.5))
    facet = np.clip(0.55 * spoke + 0.45 * ring, 0.0, 1.0)

    # 中心亮白能量核 + 外缘宝石折射层次（保留高明度白/极浅蓝，引擎用 color/emissive 驱动冰蓝或猩红）
    bright = np.clip(1.08 - r * 0.38 + (facet - 0.5) * 0.22, 0.45, 1.0)
    rgb = np.stack([bright * 0.92, bright * 0.98, bright], axis=-1)
    Image.fromarray((np.clip(rgb, 0.0, 1.0) * 255).astype(np.uint8), "RGB").save(
        os.path.join(OUT_TEX, "tiga_timer_albedo.png")
    )
    timer_norm = height_to_normal(facet * 0.28 + np.clip(1.0 - r * r, 0.0, 1.0) * 0.25, strength=2.0)
    Image.fromarray(timer_norm, "RGB").save(os.path.join(OUT_TEX, "tiga_timer_normal.png"))


def enhance_official_hero_pbr(
    hero_id: str,
    albedo_path: str,
    normal_path: str,
    emissive_path: str | None,
    metal_mask_path: str | None = None,
    target_size: int = 2048,
):
    """
    为官方正版游戏原模（赛罗 / 戴拿 / 泽塔）构建 2K 影视级全通道 PBR 纹理：
    - 2K 超分 + 自适应局部锐化漫反射（保留所有原厂褶皱与精绘细节，色彩更厚重饱满）
    - 2K 精准分区 Metallic-Roughness（智能识别银色头盔/胸甲、金色护甲、特摄皮套，金属与皮套质感彻底分层）
    - 2K 增强原厂法线 + 细腻皮套微粒法线融合
    - 1K 高清精准自发光贴图（用原厂低分发光图作精确空间掩膜，从 2K 锐化主贴图高清抠取复眼/计时器/光束灯！）
    """
    print(f"正在生成 {hero_id.upper()} 2K 影视级 PBR 贴图...")
    img_d = Image.open(albedo_path).convert("RGB")
    img_d2k = img_d.resize((target_size, target_size), Image.Resampling.LANCZOS)
    # 细腻反锐化蒙版提升铠甲线条与复眼晶格锐度（零振铃伪影）
    img_d2k = img_d2k.filter(ImageFilter.UnsharpMask(radius=1.4, percent=115, threshold=3))
    img_d2k = ImageEnhance.Contrast(img_d2k).enhance(1.06)
    img_d2k = ImageEnhance.Color(img_d2k).enhance(1.10)
    arr = np.asarray(img_d2k, dtype=np.float32) / 255.0

    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    max_c = np.maximum(np.maximum(r, g), b)
    min_c = np.minimum(np.minimum(r, g), b)
    sat = (max_c - min_c) / np.maximum(max_c, 1e-4)
    lum = 0.299 * r + 0.587 * g + 0.114 * b

    # 识别银色金属盔甲/头雕（低饱和 + 中高亮度）与金色胸甲（暖黄/香槟金）
    is_silver_armor = np.clip((0.18 - sat) / 0.12, 0.0, 1.0) * np.clip((lum - 0.34) / 0.28, 0.0, 1.0)
    is_gold_armor = (
        np.clip((r - b - 0.16) / 0.18, 0.0, 1.0)
        * np.clip((g - b - 0.10) / 0.16, 0.0, 1.0)
        * np.clip((g / np.maximum(r, 1e-4) - 0.62) / 0.22, 0.0, 1.0)
        * np.clip((lum - 0.35) / 0.25, 0.0, 1.0)
    )
    is_dark_detail = np.clip((0.26 - lum) / 0.16, 0.0, 1.0)

    # 若有官方金属高光掩膜（赛罗自带 Race_1201_m.png），与色区智能融合
    if metal_mask_path and os.path.exists(metal_mask_path):
        m_img = Image.open(metal_mask_path).convert("L").resize((target_size, target_size), Image.Resampling.LANCZOS)
        m_official = np.asarray(m_img, dtype=np.float32) / 255.0
        # 赛罗原厂金属遮罩叠加银甲金甲分区
        metallic = np.clip(
            np.maximum(m_official * 0.82, is_silver_armor * 0.68 + is_gold_armor * 0.84)
            * (1.0 - is_dark_detail * 0.55),
            0.06,
            0.88,
        )
    else:
        metallic = np.clip(
            0.10 + is_silver_armor * 0.58 + is_gold_armor * 0.74 - is_dark_detail * 0.08,
            0.06,
            0.86,
        )

    grain = tileable_micro_grain(target_size, seed=abs(hash(hero_id)) % 10000, scale_a=1.0)
    # 银/金金属区光洁度高(rough=0.22~0.26)，红/蓝皮套区半哑光柔滑(rough=0.39~0.44)，深色暗槽稍糙(0.55)
    armor_w = np.clip(is_silver_armor + is_gold_armor, 0.0, 1.0)
    roughness = np.clip(
        0.42 * (1.0 - armor_w) + 0.23 * armor_w + is_dark_detail * 0.16 + grain * 0.015 * (1.0 - armor_w),
        0.18,
        0.72,
    )
    ao = np.clip(0.82 + 0.18 * np.clip(lum / 0.45, 0.0, 1.0), 0.72, 1.0)

    # 写 2K 锐化漫反射与 ORM
    img_d2k.save(os.path.join(OUT_TEX, f"{hero_id}_albedo.png"))
    orm = np.stack([ao, roughness, metallic], axis=-1)
    Image.fromarray((orm * 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, f"{hero_id}_orm.png"))

    # 融合原厂法线贴图 + 细腻特摄微颗粒（Reoriented Normal Blending 近似）
    img_n = Image.open(normal_path).convert("RGB").resize((target_size, target_size), Image.Resampling.LANCZOS)
    n_base = np.asarray(img_n, dtype=np.float32) / 255.0 * 2.0 - 1.0
    n_micro = (height_to_normal(grain * (0.014 * (1.0 - armor_w) + 0.006 * armor_w), strength=1.8).astype(np.float32) / 255.0) * 2.0 - 1.0
    nx = n_base[:, :, 0] * 1.15 + n_micro[:, :, 0] * 0.55
    ny = n_base[:, :, 1] * 1.15 + n_micro[:, :, 1] * 0.55
    nz = np.maximum(0.15, n_base[:, :, 2])
    inv_l = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    n_out = np.stack([(nx * inv_l) * 0.5 + 0.5, (ny * inv_l) * 0.5 + 0.5, (nz * inv_l) * 0.5 + 0.5], axis=-1)
    Image.fromarray(np.clip(n_out * 255.0, 0, 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, f"{hero_id}_normal.png"))

    # 高清 1024 自发光重构：用原厂发光图定位发光区域，从 2K 漫反射精准提炼锐利晶格双眼/计时器/光束灯
    if emissive_path and os.path.exists(emissive_path):
        e_orig = Image.open(emissive_path).convert("RGB").resize((1024, 1024), Image.Resampling.LANCZOS)
        e_arr = np.asarray(e_orig, dtype=np.float32) / 255.0
        e_lum = np.max(e_arr, axis=-1)
        # 用温和羽化掩膜避免 64x64 锯齿，再用主贴图自身高亮特征精准收边！
        d_1k = np.asarray(img_d2k.resize((1024, 1024), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
        d_lum = np.max(d_1k, axis=-1)
        # 仅保留原发光区附近且主贴图足够明亮的晶莹区域（排除黑色眼眶描边渗光）
        mask_broad = gaussian_filter((e_lum > 0.08).astype(np.float32), sigma=2.2)
        mask_sharp = np.clip((d_lum - 0.36) / 0.32, 0.0, 1.0)
        final_mask = np.clip(mask_broad * 1.35, 0.0, 1.0) * np.clip(mask_sharp + (e_lum > 0.35).astype(np.float32) * 0.5, 0.0, 1.0)
        # 融合主贴图高清色彩细节与原发光色相
        em_col = d_1k * 0.78 + e_arr * 0.22
        em_out = np.clip(em_col * final_mask[:, :, None] * 1.08, 0.0, 1.0)
        Image.fromarray((em_out * 255).astype(np.uint8), "RGB").save(os.path.join(OUT_TEX, f"{hero_id}_emissive.png"))

    print(f"✓ {hero_id.upper()} 2K PBR 纹理生成完成")


if __name__ == "__main__":
    build_tiga_textures()
    zero_dir = os.path.join(WORK_DIR, "downloads/zero_pb/Ultraman Zero")
    enhance_official_hero_pbr(
        "zero",
        os.path.join(zero_dir, "Race_1201.png"),
        os.path.join(zero_dir, "Race_1201_n.png"),
        os.path.join(zero_dir, "Race_1201_h.png"),
        os.path.join(zero_dir, "Race_1201_m.png"),
        target_size=2048,
    )
    enhance_official_hero_pbr(
        "dyna",
        os.path.join(WORK_DIR, "inspect_detail/orig_dyna_Race_1259_d.png"),
        os.path.join(WORK_DIR, "inspect_detail/orig_dyna_Race_1259_n.png"),
        os.path.join(WORK_DIR, "inspect_detail/orig_dyna_dyna_emissive_final.png"),
        None,
        target_size=2048,
    )
    enhance_official_hero_pbr(
        "zeta",
        os.path.join(WORK_DIR, "inspect_detail/orig_zeta_Race_1189.png"),
        os.path.join(WORK_DIR, "inspect_detail/orig_zeta_Race_1189_n.png"),
        os.path.join(WORK_DIR, "inspect_detail/orig_zeta_zeta_emissive_final.png"),
        None,
        target_size=2048,
    )
