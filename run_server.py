# -*- coding: utf-8 -*-
import os
import re
import json
from pathlib import Path
from http.server import SimpleHTTPRequestHandler
import socketserver

BASE_DIR = Path(__file__).resolve().parent
MP3_DIR = BASE_DIR / 'mp3'
IMG_DIR = BASE_DIR / 'img-one'
PLAYLIST_FILE = BASE_DIR / 'playlist.json'
PHOTOS_FILE = BASE_DIR / 'cube-photos.json'
PORT = int(os.environ.get('PORT', '8000'))

AUDIO_EXTS = {'.mp3', '.MP3'}
IMG_EXTS = {'.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG'}

num_inner_pat = re.compile(r'^0(\d+)\.[^\.]+$')  # 01.jpg -> group(1) = '1'
num_outer_pat = re.compile(r'^(?!0)(\d+)\.[^\.]+$')  # 1.jpg / 10.jpg


def scan_playlist():
    if not MP3_DIR.exists():
        return []
    files = [p for p in MP3_DIR.iterdir() if p.is_file() and p.suffix in AUDIO_EXTS]
    # 稳定顺序：先按纯数字名（若有）再按名称排序
    def key_func(p: Path):
        name = p.stem
        return (0, int(name)) if name.isdigit() else (1, name.lower())
    files.sort(key=key_func)
    return [f'./mp3/{p.name}' for p in files]


def scan_photos():
    if not IMG_DIR.exists():
        return []
    files = [p for p in IMG_DIR.iterdir() if p.is_file() and p.suffix in IMG_EXTS]
    inner = {}  # num -> path (0前缀)
    outer = {}  # num -> path (无前缀0)
    others = []
    for p in files:
        m_in = num_inner_pat.match(p.name)
        m_out = num_outer_pat.match(p.name)
        if m_in:
            num = int(m_in.group(1))
            inner[num] = f'./img-one/{p.name}'
        elif m_out:
            num = int(m_out.group(1))
            outer[num] = f'./img-one/{p.name}'
        else:
            # 非数字命名的图片忽略（如按钮图标）
            continue
    photos = []
    used_outer_nums = set()
    for num in sorted(inner.keys()):
        photos.append(inner[num])
        if num in outer:
            photos.append(outer[num])
            used_outer_nums.add(num)
    # 追加尚未配对但存在的外层图片（可作为兜底）
    for num in sorted(outer.keys()):
        if num not in used_outer_nums:
            photos.append(outer[num])
    return photos


def ensure_playlist_json():
    data = {
        'playlist': scan_playlist(),
        'autoplay': True,
        'shuffle': True,
        'comment': '自动生成：添加新音乐到 mp3 文件夹后，重新运行本脚本即可更新。'
    }
    with open(PLAYLIST_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'[OK] 写入 {PLAYLIST_FILE.name}，共 {len(data["playlist"]) } 首')


def ensure_cube_photos_json():
    photos = scan_photos()
    data = {
        'photos': photos,
        'slideInterval': 4000,
        'comment': '自动生成：添加新图片到 img-one 文件夹后，重新运行本脚本即可更新。'
    }
    with open(PHOTOS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'[OK] 写入 {PHOTOS_FILE.name}，共 {len(photos)} 张')


def main():
    ensure_playlist_json()
    ensure_cube_photos_json()




if __name__ == '__main__':
    main()