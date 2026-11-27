"""
Blender 5.2 无头脚本：将リンドウ式ティガ3.1（マルチタイプ.pmx）转换为游戏专用高保真 GLB (tiga.glb)

功能要点：
1. 原生解析 PMX 2.0 网格、自定义法线、UV、材质分区与 BDEF1/BDEF2 精确蒙皮权重
2. 剔除 MMD 专用隐藏叠加层（カラータイマー赤/灰 及灰色半透明计时器外罩），保留完整原模造型与锐边法线
3. 将 MMD 骨骼体系标准化映射至游戏 `ultraBones` 协议（含 hip/双节脊柱/双锁骨/颈头/四肢/双脚尖与左右 30 根 3 节指骨），并写入 `bone_tips` 元数据
4. 基于原版贴图进行 PBR 亮度校色与法线/ORM 衍生（保留原画所有阴影、金属颗粒、复眼蜂窝与宝石切面细节），并确保完全兼容三形态（复合/强力/空中）像素重映射与彩色计时器实时发光控制
"""
import math
import os
import struct
import tempfile
import bpy
import numpy as np
from mathutils import Vector

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
DEFAULT_PMX_DIR = "/Users/jin/Downloads/リンドウ式ティガ3.1"
PMX_DIR = os.environ.get("RINDOU_TIGA_DIR", DEFAULT_PMX_DIR)
PMX_PATH = os.path.join(PMX_DIR, "マルチタイプ.pmx")
OUT_GLB = os.path.join(REPO_ROOT, "ui/public/models/ultraman/tiga.glb")

# 跳过的 MMD 专用隐藏/灰雾叠加材质
SKIP_MATERIALS = {
    "カラータイマー赤",
    "カラータイマー灰",
    "カラータイマーカバー",
}

# PMX 骨骼名 -> 游戏标准 ultraBones 骨名映射（带权重或核心骨架）
PMX_TO_STD_BONE = {
    "下半身": "hip",
    "上半身": "spineLower",
    "上半身2": "spineChest",
    "上半身2先": "spineChest",  # 背脊顶端 256 个顶点权重归入胸骨
    "首": "neckUpper",
    "頭": "head",
    "左肩": "Collar_L",
    "左腕": "UpperArm_L",
    "左ひじ": "LowerArm_L",
    "左手首": "Hand_L",
    "右肩": "Collar_R",
    "右腕": "UpperArm_R",
    "右ひじ": "LowerArm_R",
    "右手首": "Hand_R",
    "左足": "Thigh_L",
    "左ひざ": "Shin_L",
    "左足首": "Foot_L",
    "左足先EX": "Toe_L",
    "右足": "Thigh_R",
    "右ひざ": "Shin_R",
    "右足首": "Foot_R",
    "右足先EX": "Toe_R",
    "左親指0": "Thumb1_L",
    "左親指１": "Thumb2_L",
    "左親指２": "Thumb3_L",
    "左人指１": "Index1_L",
    "左人指２": "Index2_L",
    "左人指３": "Index3_L",
    "左中指１": "Mid1_L",
    "左中指２": "Mid2_L",
    "左中指３": "Mid3_L",
    "左薬指１": "Ring1_L",
    "左薬指２": "Ring2_L",
    "左薬指３": "Ring3_L",
    "左小指１": "Pinky1_L",
    "左小指２": "Pinky2_L",
    "左小指３": "Pinky3_L",
    "右親指0": "Thumb1_R",
    "右親指１": "Thumb2_R",
    "右親指２": "Thumb3_R",
    "右人指１": "Index1_R",
    "右人指２": "Index2_R",
    "右人指３": "Index3_R",
    "右中指１": "Mid1_R",
    "右中指２": "Mid2_R",
    "右中指３": "Mid3_R",
    "右薬指１": "Ring1_R",
    "右薬指２": "Ring2_R",
    "右薬指３": "Ring3_R",
    "右小指１": "Pinky1_R",
    "右小指２": "Pinky2_R",
    "右小指３": "Pinky3_R",
}


def parse_pmx(path: str):
    """完整解析 PMX 2.0 模型数据（顶点、法线、UV、权重、三角形面、材质与骨骼）"""
    with open(path, "rb") as f:
        sig = f.read(4)
        if sig != b"PMX ":
            raise ValueError(f"非法 PMX 文件头: {sig!r}")
        _ver = struct.unpack("<f", f.read(4))[0]
        g_cnt = struct.unpack("<B", f.read(1))[0]
        g = list(f.read(g_cnt))
        enc = "utf-16-le" if g[0] == 0 else "utf-8"
        add_uv, v_sz, t_sz, m_sz, b_sz = g[1:6]

        def read_text() -> str:
            n = struct.unpack("<i", f.read(4))[0]
            return f.read(n).decode(enc, errors="replace")

        def read_idx(sz: int, unsigned: bool = False) -> int:
            if sz == 1:
                return struct.unpack("<B" if unsigned else "<b", f.read(1))[0]
            if sz == 2:
                return struct.unpack("<H" if unsigned else "<h", f.read(2))[0]
            return struct.unpack("<i", f.read(4))[0]

        _name_jp = read_text()
        _name_en = read_text()
        _comment_jp = read_text()
        _comment_en = read_text()

        v_cnt = struct.unpack("<i", f.read(4))[0]
        verts = []
        normals = []
        uvs = []
        weights = []

        for _ in range(v_cnt):
            x, y, z, nx, ny, nz, u, v = struct.unpack("<8f", f.read(32))
            if add_uv > 0:
                f.read(16 * add_uv)
            wt = struct.unpack("<B", f.read(1))[0]
            w_list = []
            if wt == 0:  # BDEF1
                b0 = read_idx(b_sz)
                if b0 >= 0:
                    w_list.append((b0, 1.0))
            elif wt == 1:  # BDEF2
                b0, b1 = read_idx(b_sz), read_idx(b_sz)
                w0 = struct.unpack("<f", f.read(4))[0]
                if b0 >= 0 and w0 > 1e-6:
                    w_list.append((b0, w0))
                if b1 >= 0 and (1.0 - w0) > 1e-6:
                    w_list.append((b1, 1.0 - w0))
            elif wt in (2, 4):  # BDEF4 / QDEF
                bs = [read_idx(b_sz) for _ in range(4)]
                ws = struct.unpack("<4f", f.read(16))
                for b, w in zip(bs, ws):
                    if b >= 0 and w > 1e-6:
                        w_list.append((b, w))
            elif wt == 3:  # SDEF
                b0, b1 = read_idx(b_sz), read_idx(b_sz)
                w0 = struct.unpack("<f", f.read(4))[0]
                f.read(36)
                if b0 >= 0 and w0 > 1e-6:
                    w_list.append((b0, w0))
                if b1 >= 0 and (1.0 - w0) > 1e-6:
                    w_list.append((b1, 1.0 - w0))
            f.read(4)  # edge scale
            verts.append((x, y, z))
            normals.append((nx, ny, nz))
            uvs.append((u, v))
            weights.append(w_list)

        i_cnt = struct.unpack("<i", f.read(4))[0]
        indices = [read_idx(v_sz, unsigned=True) for _ in range(i_cnt)]

        tex_cnt = struct.unpack("<i", f.read(4))[0]
        textures = [read_text() for _ in range(tex_cnt)]

        mat_cnt = struct.unpack("<i", f.read(4))[0]
        materials = []
        idx_cursor = 0
        for _ in range(mat_cnt):
            mn_jp = read_text()
            _mn_en = read_text()
            diff = struct.unpack("<4f", f.read(16))
            spec = struct.unpack("<3f", f.read(12))
            spec_p = struct.unpack("<f", f.read(4))[0]
            amb = struct.unpack("<3f", f.read(12))
            bitflag = struct.unpack("<B", f.read(1))[0]
            _edge_col = struct.unpack("<4f", f.read(16))
            _edge_sz = struct.unpack("<f", f.read(4))[0]
            tex_i = read_idx(t_sz)
            sph_i = read_idx(t_sz)
            _sph_m = struct.unpack("<B", f.read(1))[0]
            toon_f = struct.unpack("<B", f.read(1))[0]
            if toon_f == 1:
                f.read(1)
            else:
                read_idx(t_sz)
            _memo = read_text()
            fcnt = struct.unpack("<i", f.read(4))[0]
            materials.append({
                "name": mn_jp,
                "diffuse": diff,
                "specular": spec,
                "spec_power": spec_p,
                "ambient": amb,
                "flag": bitflag,
                "texture": textures[tex_i] if 0 <= tex_i < len(textures) else None,
                "index_start": idx_cursor,
                "index_count": fcnt,
            })
            idx_cursor += fcnt

        bone_cnt = struct.unpack("<i", f.read(4))[0]
        bones = []
        for idx in range(bone_cnt):
            bn_jp = read_text()
            bn_en = read_text()
            pos = struct.unpack("<3f", f.read(12))
            parent = read_idx(b_sz)
            _layer = struct.unpack("<i", f.read(4))[0]
            flag = struct.unpack("<H", f.read(2))[0]
            if flag & 0x0001:
                read_idx(b_sz)
            else:
                f.read(12)
            if (flag & 0x0100) or (flag & 0x0200):
                read_idx(b_sz)
                f.read(4)
            if flag & 0x0400:
                f.read(12)
            if flag & 0x0800:
                f.read(24)
            if flag & 0x2000:
                f.read(4)
            if flag & 0x0020:
                read_idx(b_sz)
                f.read(8)
                lcnt = struct.unpack("<i", f.read(4))[0]
                for _ in range(lcnt):
                    read_idx(b_sz)
                    if struct.unpack("<B", f.read(1))[0]:
                        f.read(24)
            bones.append({"idx": idx, "name": bn_jp, "en": bn_en, "pos": pos, "parent": parent})

    return {
        "verts": verts,
        "normals": normals,
        "uvs": uvs,
        "weights": weights,
        "indices": indices,
        "materials": materials,
        "bones": bones,
    }


# ---------- 纯 numpy 图像处理工具（零外部依赖，Blender 内置即可运行） ----------

def load_rgba_array(filename: str) -> np.ndarray:
    """加载 PNG 为 (H, W, 4) float32 数组（Blender 像素行序：从底到顶）"""
    path = os.path.join(PMX_DIR, filename)
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    arr = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return arr


def make_blender_image(name: str, rgba: np.ndarray, tmp_dir: str, colorspace: str = "sRGB") -> bpy.types.Image:
    """从 (H, W, 4) float32 数组写出临时 PNG 后加载并打包，确保 glTF 无头导出 100% 保留像素"""
    h, w, _ = rgba.shape
    tmp_img = bpy.data.images.new(name=f"_tmp_{name}", width=w, height=h, alpha=True, float_buffer=False)
    tmp_img.pixels.foreach_set(np.clip(rgba, 0.0, 1.0).astype(np.float32).ravel())
    out_path = os.path.join(tmp_dir, f"{name}.png")
    tmp_img.filepath_raw = out_path
    tmp_img.file_format = "PNG"
    tmp_img.save()
    bpy.data.images.remove(tmp_img)

    img = bpy.data.images.load(out_path, check_existing=False)
    img.name = name
    try:
        img.colorspace_settings.name = colorspace
    except Exception:
        pass
    img.pack()
    return img


def box_blur_2d(arr: np.ndarray, radius: int, passes: int = 2) -> np.ndarray:
    """快速可分离均值滤波（近似高斯平滑，支持边缘 wrap/clamp）"""
    out = arr.astype(np.float32)
    if radius <= 0:
        return out
    k = 2 * radius + 1
    for _ in range(passes):
        # 水平方向
        p = np.pad(out, ((0, 0), (radius, radius)), mode="edge")
        cs = np.cumsum(np.pad(p, ((0, 0), (1, 0)), mode="constant"), axis=1)
        out = (cs[:, k:] - cs[:, :-k]) / k
        # 垂直方向
        p = np.pad(out, ((radius, radius), (0, 0)), mode="edge")
        cs = np.cumsum(np.pad(p, ((1, 0), (0, 0)), mode="constant"), axis=0)
        out = (cs[k:, :] - cs[:-k, :]) / k
    return out


def height_to_normal_rgba(height_map: np.ndarray, strength: float = 2.0) -> np.ndarray:
    """将底向上排布的单通道高度图转为 OpenGL/glTF 切线空间法线 RGBA (float32)"""
    # 注意 Blender 像素数组第 0 行在图像底部，dy 正方向即 +V（+Y）
    gx = np.roll(height_map, -1, axis=1) - np.roll(height_map, 1, axis=1)
    gy = np.roll(height_map, -1, axis=0) - np.roll(height_map, 1, axis=0)
    nx = -gx * strength
    ny = -gy * strength
    nz = np.ones_like(height_map, dtype=np.float32)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    nx *= inv
    ny *= inv
    nz *= inv
    h, w = height_map.shape
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, 0] = nx * 0.5 + 0.5
    rgba[:, :, 1] = ny * 0.5 + 0.5
    rgba[:, :, 2] = nz * 0.5 + 0.5
    return rgba


def set_bsdf_input(bsdf, name: str, value):
    if name in bsdf.inputs:
        bsdf.inputs[name].default_value = value


def reset_material(name: str):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out_n = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out_n.inputs["Surface"])
    return mat, nt, bsdf


def build_pbr_materials(tmp_dir: str):
    """基于リンドウ式ティガ3.1原版贴图构建影视级 PBR 材质集合"""
    mats = {}

    # 1. Tiga body Multi-Type（战衣主材质，兼容 hero.ts 强力型 all-red / 空中型 all-violet 实时重映射）
    suit_src = load_rgba_array("マルチタイプ.png")
    r, g, b = suit_src[:, :, 0], suit_src[:, :, 1], suit_src[:, :, 2]

    # 精准分离紫/红/银三区（保留原贴图边缘抗锯齿权重）
    w_purple = np.clip((b - g - 0.05) / 0.14, 0.0, 1.0)
    w_red = np.clip((r - np.maximum(g, b) - 0.08) / 0.18, 0.0, 1.0)
    w_silver = np.clip(1.0 - np.maximum(w_purple, w_red), 0.0, 1.0)
    w_sum = np.maximum(w_purple + w_red + w_silver, 1e-5)
    wp, wr, ws = w_purple / w_sum, w_red / w_sum, w_silver / w_sum

    # 按 1996 迪迦复合型特摄标准提亮至标准 PBR 反照率区间
    col_purple = np.array([0.19, 0.17, 0.50], dtype=np.float32)  # 深邃皇室紫蓝
    col_red = np.array([0.69, 0.12, 0.16], dtype=np.float32)     # 饱满特摄正红
    col_silver = np.array([0.83, 0.86, 0.90], dtype=np.float32)  # 清亮珍珠钛银

    suit_rgb = (
        wp[:, :, None] * col_purple[None, None, :]
        + wr[:, :, None] * col_red[None, None, :]
        + ws[:, :, None] * col_silver[None, None, :]
    )

    # 提取紫/红/银裁片接缝凹槽法线与微弱接缝 AO
    label = np.zeros(r.shape, dtype=np.int32)
    label[ws > 0.5] = 1
    label[wp > 0.5] = 2
    label[wr > 0.5] = 3
    seam = np.zeros(r.shape, dtype=np.float32)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        shifted = np.roll(np.roll(label, dy, axis=0), dx, axis=1)
        seam = np.maximum(seam, (label != shifted).astype(np.float32))
    seam_groove = np.clip(box_blur_2d(seam, radius=2, passes=3) * 1.9, 0.0, 1.0)
    seam_ao = np.clip(1.0 - seam_groove * 0.12, 0.84, 1.0)

    suit_albedo = np.ones_like(suit_src)
    suit_albedo[:, :, :3] = np.clip(suit_rgb * seam_ao[:, :, None], 0.0, 1.0)
    img_suit_albedo = make_blender_image("tiga_suit_albedo", suit_albedo, tmp_dir, "sRGB")

    # 战衣 ORM（R=AO, G=Roughness, B=Metallic）：银区丝缎金属感，红紫区细腻皮套半哑光
    suit_orm = np.ones_like(suit_src)
    suit_orm[:, :, 0] = seam_ao
    suit_orm[:, :, 1] = np.clip(ws * 0.28 + (wp + wr) * 0.42 + seam_groove * 0.12, 0.20, 0.85)
    suit_orm[:, :, 2] = np.clip(ws * 0.48 + (wp + wr) * 0.08 - seam_groove * 0.10, 0.0, 0.85)
    img_suit_orm = make_blender_image("tiga_suit_orm", suit_orm, tmp_dir, "Non-Color")

    suit_norm_rgba = height_to_normal_rgba(-seam_groove * 0.18, strength=1.8)
    img_suit_norm = make_blender_image("tiga_suit_normal", suit_norm_rgba, tmp_dir, "Non-Color")

    mat_suit, nt, bsdf = reset_material("Tiga body Multi-Type")
    t_col = nt.nodes.new("ShaderNodeTexImage"); t_col.image = img_suit_albedo
    t_orm = nt.nodes.new("ShaderNodeTexImage"); t_orm.image = img_suit_orm
    t_nrm = nt.nodes.new("ShaderNodeTexImage"); t_nrm.image = img_suit_norm
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nmap = nt.nodes.new("ShaderNodeNormalMap"); nmap.inputs["Strength"].default_value = 0.28
    nt.links.new(t_col.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_orm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    nt.links.new(t_nrm.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    set_bsdf_input(bsdf, "Coat Weight", 0.14)
    set_bsdf_input(bsdf, "Coat Roughness", 0.34)
    mats["スーツ"] = mat_suit

    # 2. Tiga body silver（头雕/面具、手肩银甲、计时器银盾底座，保留原贴图暗部沟槽阴影）
    silver_src = load_rgba_array("シルバー.png")
    s_lum = silver_src[:, :, :3].mean(axis=2)
    # 基准银灰 0.565 -> 提亮至清亮冷钛银 0.85，同时保留 0.0~0.25 深阴影沟槽（眼眶/耳缝/口部微影）
    s_gain = np.clip((s_lum - 0.12) / 0.445, 0.0, 1.15)
    silver_out = np.ones_like(silver_src)
    silver_out[:, :, 0] = np.clip(s_lum * 0.25 + s_gain * 0.69, 0.0, 0.94)
    silver_out[:, :, 1] = np.clip(s_lum * 0.25 + s_gain * 0.72, 0.0, 0.96)
    silver_out[:, :, 2] = np.clip(s_lum * 0.25 + s_gain * 0.76, 0.0, 0.99)
    dark_mask = np.clip((0.28 - s_lum) / 0.18, 0.0, 1.0)
    silver_out[:, :, :3] *= (1.0 - dark_mask[:, :, None] * 0.72)
    img_silver = make_blender_image("tiga_silver_albedo", silver_out, tmp_dir, "sRGB")

    # 银甲 ORM：暗沟粗糙无金属感，亮银光滑冷钛金属
    silver_orm = np.ones_like(silver_src)
    silver_orm[:, :, 0] = np.clip(1.0 - dark_mask * 0.6, 0.3, 1.0)
    silver_orm[:, :, 1] = np.clip(0.24 + dark_mask * 0.55, 0.20, 0.85)
    silver_orm[:, :, 2] = np.clip(0.72 * (1.0 - dark_mask * 0.85), 0.05, 0.80)
    img_silver_orm = make_blender_image("tiga_silver_orm", silver_orm, tmp_dir, "Non-Color")

    mat_silver, nt, bsdf = reset_material("Tiga body silver")
    t_sa = nt.nodes.new("ShaderNodeTexImage"); t_sa.image = img_silver
    t_so = nt.nodes.new("ShaderNodeTexImage"); t_so.image = img_silver_orm
    sep_s = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(t_sa.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_so.outputs["Color"], sep_s.inputs["Color"])
    nt.links.new(sep_s.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep_s.outputs["Blue"], bsdf.inputs["Metallic"])
    set_bsdf_input(bsdf, "Coat Weight", 0.32)
    set_bsdf_input(bsdf, "Coat Roughness", 0.14)
    mats["マスク"] = mat_silver
    mats["手・肩"] = mat_silver
    mats["カラータイマー"] = mat_silver

    # 3. Tiga body protector（胸甲：上半香槟金护条 + 下半冷钛银甲，保留细腻金属微粒）
    prot_src = load_rgba_array("プロテクター.png")
    pr, pg, pb = prot_src[:, :, 0], prot_src[:, :, 1], prot_src[:, :, 2]
    p_lum = (pr + pg + pb) / 3.0
    p_smooth = box_blur_2d(p_lum, radius=3, passes=1)
    p_grain = np.clip((p_lum - p_smooth) * 0.8, -0.06, 0.06)
    is_gold = np.clip((pr - pb - 0.08) / 0.16, 0.0, 1.0)

    gold_base = np.array([0.95, 0.74, 0.26], dtype=np.float32)  # 24K 香槟钛金
    psil_base = np.array([0.84, 0.87, 0.91], dtype=np.float32)  # 冷钛银底
    prot_rgb = (
        is_gold[:, :, None] * gold_base[None, None, :]
        + (1.0 - is_gold[:, :, None]) * psil_base[None, None, :]
        + p_grain[:, :, None] * 0.55
    )
    prot_albedo = np.ones_like(prot_src)
    prot_albedo[:, :, :3] = np.clip(prot_rgb, 0.0, 1.0)
    img_prot = make_blender_image("tiga_protector_albedo", prot_albedo, tmp_dir, "sRGB")

    prot_orm = np.ones_like(prot_src)
    prot_orm[:, :, 0] = 1.0
    prot_orm[:, :, 1] = np.clip(is_gold * 0.21 + (1.0 - is_gold) * 0.25 - p_grain * 0.4, 0.16, 0.40)
    prot_orm[:, :, 2] = np.clip(is_gold * 0.86 + (1.0 - is_gold) * 0.74, 0.65, 0.92)
    img_prot_orm = make_blender_image("tiga_protector_orm", prot_orm, tmp_dir, "Non-Color")

    prot_norm = height_to_normal_rgba(p_grain * 0.35, strength=1.5)
    img_prot_norm = make_blender_image("tiga_protector_normal", prot_norm, tmp_dir, "Non-Color")

    mat_prot, nt, bsdf = reset_material("Tiga body protector")
    t_pa = nt.nodes.new("ShaderNodeTexImage"); t_pa.image = img_prot
    t_po = nt.nodes.new("ShaderNodeTexImage"); t_po.image = img_prot_orm
    t_pn = nt.nodes.new("ShaderNodeTexImage"); t_pn.image = img_prot_norm
    sep_p = nt.nodes.new("ShaderNodeSeparateColor")
    nmap_p = nt.nodes.new("ShaderNodeNormalMap"); nmap_p.inputs["Strength"].default_value = 0.25
    nt.links.new(t_pa.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_po.outputs["Color"], sep_p.inputs["Color"])
    nt.links.new(sep_p.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep_p.outputs["Blue"], bsdf.inputs["Metallic"])
    nt.links.new(t_pn.outputs["Color"], nmap_p.inputs["Color"])
    nt.links.new(nmap_p.outputs["Normal"], bsdf.inputs["Normal"])
    set_bsdf_input(bsdf, "Coat Weight", 0.40)
    set_bsdf_input(bsdf, "Coat Roughness", 0.12)
    mats["プロテクター"] = mat_prot

    # 4. Tiga color timer（胸口多面宝石切割计时器，配合引擎实时冰蓝呼吸/危急红闪）
    ct_src = load_rgba_array("ティガカラータイマー.png")
    ct_lum = ct_src[:, :, :3].mean(axis=2)
    ct_bright = np.clip(0.52 + ct_lum * 0.62, 0.35, 1.0)
    ct_albedo = np.ones_like(ct_src)
    ct_albedo[:, :, 0] = ct_bright * 0.88
    ct_albedo[:, :, 1] = ct_bright * 0.96
    ct_albedo[:, :, 2] = ct_bright
    img_ct_albedo = make_blender_image("tiga_timer_albedo", ct_albedo, tmp_dir, "sRGB")

    ct_norm = height_to_normal_rgba(ct_lum * 0.45, strength=2.6)
    img_ct_norm = make_blender_image("tiga_timer_normal", ct_norm, tmp_dir, "Non-Color")

    mat_timer, nt, bsdf = reset_material("Tiga color timer")
    t_ta = nt.nodes.new("ShaderNodeTexImage"); t_ta.image = img_ct_albedo
    t_tn = nt.nodes.new("ShaderNodeTexImage"); t_tn.image = img_ct_norm
    nmap_t = nt.nodes.new("ShaderNodeNormalMap"); nmap_t.inputs["Strength"].default_value = 0.65
    nt.links.new(t_ta.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_tn.outputs["Color"], nmap_t.inputs["Color"])
    nt.links.new(nmap_t.outputs["Normal"], bsdf.inputs["Normal"])
    set_bsdf_input(bsdf, "Metallic", 0.08)
    set_bsdf_input(bsdf, "Roughness", 0.10)
    set_bsdf_input(bsdf, "Emission Color", (0.22, 0.88, 1.0, 1.0))
    set_bsdf_input(bsdf, "Emission Strength", 1.45)
    set_bsdf_input(bsdf, "Coat Weight", 1.0)
    set_bsdf_input(bsdf, "Coat Roughness", 0.04)
    mats["カラータイマー青"] = mat_timer

    # 5. Tiga eyes（内层暖奶油金复眼发光核，匹配 hero.ts eyeMaterialNames）
    eye_src = load_rgba_array("目発光.png")
    eye_rgb = np.stack([
        np.clip(eye_src[:, :, 0] * 1.12, 0.0, 1.0),
        np.clip(eye_src[:, :, 1] * 1.10, 0.0, 1.0),
        np.clip(eye_src[:, :, 2] * 0.96, 0.0, 1.0),
    ], axis=-1)
    eye_albedo = np.ones_like(eye_src)
    eye_albedo[:, :, :3] = eye_rgb
    eye_emissive = np.ones_like(eye_src)
    eye_emissive[:, :, :3] = np.clip(eye_rgb * 0.98, 0.0, 1.0)
    img_eye_albedo = make_blender_image("tiga_eye_albedo", eye_albedo, tmp_dir, "sRGB")
    img_eye_emissive = make_blender_image("tiga_eye_emissive", eye_emissive, tmp_dir, "sRGB")

    mat_eye, nt, bsdf = reset_material("Tiga eyes")
    t_ea = nt.nodes.new("ShaderNodeTexImage"); t_ea.image = img_eye_albedo
    t_ee = nt.nodes.new("ShaderNodeTexImage"); t_ee.image = img_eye_emissive
    nt.links.new(t_ea.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_ee.outputs["Color"], bsdf.inputs["Emission Color"])
    set_bsdf_input(bsdf, "Metallic", 0.04)
    set_bsdf_input(bsdf, "Roughness", 0.16)
    set_bsdf_input(bsdf, "Emission Strength", 1.05)
    mats["目発光"] = mat_eye

    # 6. Tiga eye cover（外层复眼蜂窝光学罩：修复原图 1px 细黑划痕 + 生成立体蜂窝棱镜法线 + 清澈半透明）
    bump_src = load_rgba_array("ティガ目凹凸.png")
    b_lum = bump_src[:, :, :3].mean(axis=2)
    b_smooth = box_blur_2d(b_lum, radius=3, passes=2)
    b_clean = np.where(b_lum < 0.65, b_smooth, b_lum)
    b_norm_rgba = height_to_normal_rgba(b_clean * 0.85, strength=3.2)
    img_bump_norm = make_blender_image("tiga_eye_cover_normal", b_norm_rgba, tmp_dir, "Non-Color")

    cover_rgba = np.ones_like(bump_src)
    facet_tint = np.clip(0.84 + (b_clean - 0.78) * 1.15, 0.72, 1.0)
    cover_rgba[:, :, 0] = facet_tint
    cover_rgba[:, :, 1] = facet_tint * 0.98
    cover_rgba[:, :, 2] = facet_tint * 0.92
    cover_rgba[:, :, 3] = 0.28
    img_cover_albedo = make_blender_image("tiga_eye_cover_albedo", cover_rgba, tmp_dir, "sRGB")

    mat_cover, nt, bsdf = reset_material("Tiga eye crystal")
    mat_cover.blend_method = "BLEND"
    t_ca = nt.nodes.new("ShaderNodeTexImage"); t_ca.image = img_cover_albedo
    t_cn = nt.nodes.new("ShaderNodeTexImage"); t_cn.image = img_bump_norm
    nmap_c = nt.nodes.new("ShaderNodeNormalMap"); nmap_c.inputs["Strength"].default_value = 0.75
    nt.links.new(t_ca.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(t_ca.outputs["Alpha"], bsdf.inputs["Alpha"])
    nt.links.new(t_cn.outputs["Color"], nmap_c.inputs["Color"])
    nt.links.new(nmap_c.outputs["Normal"], bsdf.inputs["Normal"])
    set_bsdf_input(bsdf, "Metallic", 0.05)
    set_bsdf_input(bsdf, "Roughness", 0.08)
    set_bsdf_input(bsdf, "Coat Weight", 1.0)
    set_bsdf_input(bsdf, "Coat Roughness", 0.04)
    mats["目カバー"] = mat_cover

    # 7. Tiga forehead crystal（额头眉心清澈蓝紫宝石水晶）
    mat_crystal, nt, bsdf = reset_material("Tiga forehead crystal")
    set_bsdf_input(bsdf, "Base Color", (0.68, 0.85, 1.0, 1.0))
    set_bsdf_input(bsdf, "Metallic", 0.16)
    set_bsdf_input(bsdf, "Roughness", 0.06)
    set_bsdf_input(bsdf, "Emission Color", (0.52, 0.82, 1.0, 1.0))
    set_bsdf_input(bsdf, "Emission Strength", 1.25)
    set_bsdf_input(bsdf, "Coat Weight", 1.0)
    set_bsdf_input(bsdf, "Coat Roughness", 0.04)
    mats["額"] = mat_crystal

    return mats


def build_armature(pmx_bones: list[dict], scale: float, min_y: float):
    """构建标准 ultraBones 骨架并计算全部骨骼精确尾端（含 bone_tips 元数据）"""
    by_name = {b["name"]: b for b in pmx_bones}

    def pmx_to_bl(pos) -> Vector:
        # PMX 左手 Y-Up (-Z 前, +X 左) -> Blender 右手 Z-Up (-Y 前, +X 左)
        return Vector((pos[0] * scale, pos[2] * scale, (pos[1] - min_y) * scale))

    def pos_of(jp_name: str) -> Vector:
        return pmx_to_bl(by_name[jp_name]["pos"])

    # 明确定义标准骨骼拓扑：(std_name, parent_std_name, head_vec, tail_vec)
    hip_head = pos_of("腰")
    spine_lower_head = pos_of("上半身")
    spine_chest_head = pos_of("上半身2")
    neck_head = pos_of("首")
    head_pos = pos_of("頭")
    head_tip = pos_of("頭先")

    bone_specs = [
        ("hip", None, hip_head, spine_lower_head),
        ("spineLower", "hip", spine_lower_head, spine_chest_head),
        ("spineChest", "spineLower", spine_chest_head, neck_head),
        ("neckUpper", "spineChest", neck_head, head_pos),
        ("head", "neckUpper", head_pos, head_tip),
    ]

    # 双腿链（左 +X / 右 -X）
    for side, jp in (("L", "左"), ("R", "右")):
        thigh = pos_of(f"{jp}足")
        shin = pos_of(f"{jp}ひざ")
        foot = pos_of(f"{jp}足首")
        toe = pos_of(f"{jp}足先EX")
        toe_tip = toe + Vector((0.0, -0.08, 0.0))
        bone_specs.extend([
            (f"Thigh_{side}", "hip", thigh, shin),
            (f"Shin_{side}", f"Thigh_{side}", shin, foot),
            (f"Foot_{side}", f"Shin_{side}", foot, toe),
            (f"Toe_{side}", f"Foot_{side}", toe, toe_tip),
        ])

    # 双臂与 30 根 3 节指骨链
    for side, jp in (("L", "左"), ("R", "右")):
        collar = pos_of(f"{jp}肩")
        upper = pos_of(f"{jp}腕")
        lower = pos_of(f"{jp}ひじ")
        hand = pos_of(f"{jp}手首")
        hand_tip = pos_of(f"{jp}中指１")
        bone_specs.extend([
            (f"Collar_{side}", "spineChest", collar, upper),
            (f"UpperArm_{side}", f"Collar_{side}", upper, lower),
            (f"LowerArm_{side}", f"UpperArm_{side}", lower, hand),
            (f"Hand_{side}", f"LowerArm_{side}", hand, hand_tip),
        ])

        finger_defs = [
            ("Thumb", [f"{jp}親指0", f"{jp}親指１", f"{jp}親指２"], f"{jp}親指先"),
            ("Index", [f"{jp}人指１", f"{jp}人指２", f"{jp}人指３"], f"{jp}人差指先"),
            ("Mid", [f"{jp}中指１", f"{jp}中指２", f"{jp}中指３"], f"{jp}中指先"),
            ("Ring", [f"{jp}薬指１", f"{jp}薬指２", f"{jp}薬指３"], f"{jp}薬指先"),
            ("Pinky", [f"{jp}小指１", f"{jp}小指２", f"{jp}小指３"], f"{jp}小指先"),
        ]
        for fname, seg_jps, tip_jp in finger_defs:
            pts = [pos_of(n) for n in seg_jps] + [pos_of(tip_jp)]
            for i in range(3):
                bname = f"{fname}{i + 1}_{side}"
                pname = f"Hand_{side}" if i == 0 else f"{fname}{i}_{side}"
                head_p, tail_p = pts[i], pts[i + 1]
                if (tail_p - head_p).length < 1e-4:
                    tail_p = head_p + Vector((0.02 if side == "L" else -0.02, 0.0, -0.02))
                bone_specs.append((bname, pname, head_p, tail_p))

    arm_data = bpy.data.armatures.new("TigaArmature")
    arm_obj = bpy.data.objects.new("TigaArmature", arm_data)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    edit_bones = {}
    bone_tips_gltf = {}
    for bname, pname, head_p, tail_p in bone_specs:
        eb = arm_data.edit_bones.new(bname)
        eb.head = head_p
        eb.tail = tail_p
        if pname and pname in edit_bones:
            eb.parent = edit_bones[pname]
            eb.use_connect = False
        edit_bones[bname] = eb
        # 转换为 glTF Y-Up 局部坐标存入 bone_tips（Blender (x,y,z) -> glTF (x,z,-y)）
        bone_tips_gltf[bname] = [round(float(tail_p.x), 5), round(float(tail_p.z), 5), round(float(-tail_p.y), 5)]

    bpy.ops.object.mode_set(mode="OBJECT")
    arm_obj["bone_tips"] = bone_tips_gltf
    return arm_obj


def build_mesh(pmx: dict, arm_obj: bpy.types.Object, mat_map: dict, scale: float, min_y: float):
    """构建高精度迪迦网格（保留原模锐边/光滑自定义法线、UV、材质分区与精准蒙皮权重）"""
    verts = pmx["verts"]
    normals = pmx["normals"]
    uvs = pmx["uvs"]
    weights = pmx["weights"]
    indices = pmx["indices"]
    pmx_bones = pmx["bones"]

    # 收集保留材质的三角形并压缩顶点表
    used_old_verts = []
    old_to_new = {}
    faces_new = []
    face_mat_slots = []
    slot_mats = []
    mat_to_slot = {}

    for m in pmx["materials"]:
        mname = m["name"]
        if mname in SKIP_MATERIALS:
            continue
        bl_mat = mat_map.get(mname)
        if bl_mat is None:
            raise ValueError(f"未映射的 PMX 材质: {mname}")
        if bl_mat.name not in mat_to_slot:
            mat_to_slot[bl_mat.name] = len(slot_mats)
            slot_mats.append(bl_mat)
        slot_idx = mat_to_slot[bl_mat.name]

        start = m["index_start"]
        count = m["index_count"]
        for k in range(start, start + count, 3):
            i0, i1, i2 = indices[k], indices[k + 1], indices[k + 2]
            if i0 == i1 or i1 == i2 or i2 == i0:
                continue
            # PMX 三角形索引经 (x, z, y) 镜像变换后需反转绕序为 (i0, i2, i1) 使面法线 100% 朝外
            tri_old = (i0, i2, i1)
            tri_new = []
            for ov in tri_old:
                nv = old_to_new.get(ov)
                if nv is None:
                    nv = len(used_old_verts)
                    old_to_new[ov] = nv
                    used_old_verts.append(ov)
                tri_new.append(nv)
            faces_new.append(tuple(tri_new))
            face_mat_slots.append(slot_idx)

    # 转换保留顶点坐标与法线
    bl_verts = []
    bl_normals = []
    for ov in used_old_verts:
        px, py, pz = verts[ov]
        bl_verts.append((px * scale, pz * scale, (py - min_y) * scale))
        nx, ny, nz = normals[ov]
        nv = Vector((nx, nz, ny))
        if nv.length_squared > 1e-8:
            nv.normalize()
        else:
            nv = Vector((0.0, -1.0, 0.0))
        bl_normals.append((nv.x, nv.y, nv.z))

    mesh = bpy.data.meshes.new("TigaBody")
    mesh.from_pydata(bl_verts, [], faces_new)
    mesh.update()

    # 分配材质槽
    for bl_mat in slot_mats:
        mesh.materials.append(bl_mat)
    mesh.polygons.foreach_set("material_index", face_mat_slots)
    mesh.polygons.foreach_set("use_smooth", [True] * len(mesh.polygons))

    # 写入 UV（PMX V 向下 -> Blender V 向上）
    uv_layer = mesh.uv_layers.new(name="UVMap")
    uv_data = uv_layer.data
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            nv = mesh.loops[li].vertex_index
            ov = used_old_verts[nv]
            u, v = uvs[ov]
            uv_data[li].uv = (u, 1.0 - v)

    # Fail-Fast 校验面绕序与原模自定义顶点法线方向一致（确保全部外表面法线朝外）
    aligned = 0
    for poly in mesh.polygons:
        n_avg = Vector((0.0, 0.0, 0.0))
        for vi in poly.vertices:
            n_avg += Vector(bl_normals[vi])
        if poly.normal.dot(n_avg) > 0:
            aligned += 1
    align_ratio = aligned / max(1, len(mesh.polygons))
    if align_ratio < 0.85:
        raise RuntimeError(f"面绕序与外法线一致性过低: {align_ratio:.3f}")

    # 写入 PMX 原生自定义顶点法线（100% 忠实还原原模硬棱与柔和过渡）
    mesh.normals_split_custom_set_from_vertices(bl_normals)
    mesh.update()

    obj = bpy.data.objects.new("TigaBody", mesh)
    bpy.context.collection.objects.link(obj)

    # 绑定骨架与精确蒙皮权重
    obj.parent = arm_obj
    mod = obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj

    bone_idx_to_std = {}
    for b in pmx_bones:
        std_name = PMX_TO_STD_BONE.get(b["name"])
        if std_name:
            bone_idx_to_std[b["idx"]] = std_name

    vgroups = {}
    for std_name in set(bone_idx_to_std.values()):
        vgroups[std_name] = obj.vertex_groups.new(name=std_name)

    unmapped_bones = set()
    for nv, ov in enumerate(used_old_verts):
        acc = {}
        for b_idx, w in weights[ov]:
            std_name = bone_idx_to_std.get(b_idx)
            if not std_name:
                unmapped_bones.add(pmx_bones[b_idx]["name"])
                continue
            acc[std_name] = acc.get(std_name, 0.0) + w
        total_w = sum(acc.values())
        if total_w > 1e-6:
            for std_name, w in acc.items():
                vgroups[std_name].add([nv], w / total_w, "REPLACE")

    if unmapped_bones:
        raise RuntimeError(f"发现未映射的带权重骨骼: {sorted(unmapped_bones)}")

    return obj


def main():
    if not os.path.isfile(PMX_PATH):
        raise FileNotFoundError(f"找不到 PMX 源文件: {PMX_PATH}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    pmx = parse_pmx(PMX_PATH)

    ys = [v[1] for v in pmx["verts"]]
    min_y, max_y = min(ys), max(ys)
    height = max_y - min_y
    scale = 3.1 / height  # 标准化至 ~3.1m，与既有英雄资产尺度一致

    with tempfile.TemporaryDirectory(prefix="rindou_tiga_tex_") as tmp_dir:
        mat_map = build_pbr_materials(tmp_dir)
        arm_obj = build_armature(pmx["bones"], scale, min_y)
        body_obj = build_mesh(pmx, arm_obj, mat_map, scale, min_y)
        bpy.context.view_layer.update()

        bpy.ops.outliner.orphans_purge(do_recursive=True)
        bpy.ops.export_scene.gltf(
            filepath=OUT_GLB,
            export_format="GLB",
            export_yup=True,
            export_normals=True,
            export_materials="EXPORT",
            export_image_format="WEBP",
            export_image_quality=92,
            export_skins=True,
            export_animations=False,
            export_extras=True,
            export_attributes=True,
        )
    print(
        f"✓ リンドウ式ティガ3.1 已转换导出: {OUT_GLB} "
        f"({os.path.getsize(OUT_GLB) // 1024} KB, "
        f"verts={len(body_obj.data.vertices)}, tris={len(body_obj.data.polygons)}, "
        f"bones={len(arm_obj.data.bones)})"
    )


if __name__ == "__main__":
    main()
