import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inspectRaster } from './media-store.mjs';
import { publicError, randomToken } from './security.mjs';

const exec = promisify(execFile);
const MAX_OUTPUT_PIXELS = 32_000_000;
const MAX_DIMENSION = 7680;

function validateOptions({ width, height, mode }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 512 || height < 512 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_OUTPUT_PIXELS) throw publicError(400, '超分输出尺寸无效或过大', 'INVALID_UPSCALE_SIZE');
  if (!['detail', 'text-safe'].includes(mode)) throw publicError(400, '超分模式无效', 'INVALID_UPSCALE_MODE');
  return { width, height, mode };
}

export class LocalImageUpscaler {
  constructor({ rootDir, tempRoot = join(rootDir, '.data', 'upscale-tmp'), enginePath = join(rootDir, '..', 'image-upscaler', 'realesrgan-ncnn-vulkan', 'realesrgan-ncnn-vulkan.exe'), pythonCommand = 'python' } = {}) {
    this.tempRoot = tempRoot; this.enginePath = enginePath; this.pythonCommand = pythonCommand;
  }

  async upscale(buffer, options) {
    const { width, height, mode } = validateOptions(options); inspectRaster(buffer);
    await mkdir(this.tempRoot, { recursive: true });
    const id = randomToken(18); const input = join(this.tempRoot, `${id}-input.png`); const intermediate = join(this.tempRoot, `${id}-4x.png`); const output = join(this.tempRoot, `${id}-output.png`);
    try {
      await writeFile(input, buffer, { mode: 0o600 });
      if (mode === 'detail') await exec(this.enginePath, ['-i', input, '-o', intermediate, '-n', 'realesrgan-x4plus', '-s', '4', '-t', '256', '-f', 'png'], { timeout: 600_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      else await writeFile(intermediate, buffer, { mode: 0o600 });
      const code = "from sys import argv\nfrom PIL import Image\nwith Image.open(argv[1]) as im: im.resize((int(argv[3]),int(argv[4])),Image.Resampling.LANCZOS).save(argv[2],'PNG',optimize=True)\n";
      await exec(this.pythonCommand, ['-c', code, intermediate, output, String(width), String(height)], { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });
      const result = await readFile(output); inspectRaster(result); return result;
    } catch (error) {
      if (error?.code) throw error;
      throw publicError(502, '本地超分处理失败，请检查超分插件环境', 'LOCAL_UPSCALE_FAILED');
    } finally { await Promise.all([input, intermediate, output].map((path) => rm(path, { force: true }).catch(() => undefined))); }
  }
}
