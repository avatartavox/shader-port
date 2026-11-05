# shader-port

Experimento de la charla **"AI, MCP, Figma Shaders?"**: llevar un shader de Figma al código usando Claude Code y el MCP de Figma, y medir qué tan fiel queda.

Los módulos originales se leyeron con `get_design_context` y se portaron de tres formas, para compararlas contra la captura de Figma.

## Los tres ports

| Port | Tecnología | Qué es |
|------|------------|--------|
| **A** | WebGPU / WGSL | Los módulos de Figma **sin cambios** (`src/figma/`), ejecutados con un host mínimo. |
| **B** | WebGL2 / GLSL | Reescritura a GLSL ES 3.0. |
| **C** | Three.js | Misma lógica sobre `ShaderMaterial` y *render targets*. |

Efectos: anillos especulares concéntricos con ripple al mover el mouse, y la cadena **Glitch → Bloom → Dither** (Bayer 8×8).

## Estructura

```
src/figma/        Módulos de Figma tal cual (no editar): specular-rings, bloom, dither, broadcast
src/a-*.ts        Port A (WebGPU)
src/b-*.ts        Port B (WebGL2)
src/c-*.ts        Port C (Three.js)
src/dither/       Comparación A vs B del Dither
src/record.ts     Render cuadro a cuadro + export MP4
public/ref/       Captura de referencia de Figma
public/exports/   Comparación A/B/C y videos MP4
```

## Cómo correrlo

```bash
npm install
npm run dev
```

Páginas (con el servidor en `http://localhost:5173`; Vite muestra el puerto real):

- `/` — comparación A, B y C lado a lado, con diff de píxeles contra la captura de Figma
- `/dither.html` — comparación del Dither
- `/record.html` — grabador: renderiza cuadro a cuadro y exporta MP4 (6 s, 1920×1080, 30 fps)

Requiere un Chrome reciente con **WebGPU** y una GPU compatible para el port A.

## Resultados

Diferencia media por canal (0–255) de B y C contra A, a t = 3 s:

| Región | Con todo el ruido | Sin términos hash |
|--------|-------------------|-------------------|
| Texto | 4,94 | 0,37 |
| Cuadro completo | 0,66 | 0,05 |

## Trampas que costaron tiempo

- **Hash con `sin()`**: el mismo ruido da otro resultado en WGSL que en GLSL.
- **Redondeo**: `round()` de WGSL va a la mitad par; en GLSL hay que usar `roundEven`.
- **Eje Y**: los pases intermedios usan `uv` directo; solo el pase final invierte Y.
- **WGSL como texto**: Figma valida el shader literal, no admite `${}` ni plantillas.

## Límites conocidos

- El zoom y el fade del texto de Figma no están en los videos de código.
- El runtime oficial no es legible: el texto se dibuja con canvas 2D y puede variar.
- El Dither se probó en Figma con una sola captura.
- No se midió el rendimiento dentro de Figma, solo en los ports.
