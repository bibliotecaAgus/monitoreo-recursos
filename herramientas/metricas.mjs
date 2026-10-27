// Genera los datos de la página de estado a partir de las validaciones guardadas en registros/.
//
// Entrada (en la raíz del sitio):
//   recursos.json         lista de recursos: nombre, url_entrada, dominio_final, texto_esperado, proveedor
//   registros/*.json      una validación por archivo, venga del equipo de monitoreo o de la extensión:
//                         { fecha, origen, login, resultados: [{ nombre, ok, tipo, error, urlFinal, ms, fecha }] }
// Salida:
//   datos/estado.json     último resultado de cada recurso + disponibilidad histórica
//   datos/historial.json  una fila por validación (completa o con login fallido)
//   datos/matriz.json     estado de cada recurso en las últimas VALIDACIONES_MATRIZ validaciones
//
// Uso:  node herramientas/metricas.mjs [carpeta del sitio]
// Lo ejecutan el equipo de monitoreo (publicarSitio.ts) y el workflow de GitHub que publica la página.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROXY_HOST = 'itmsp.museknowledge.com';
/** Una validación cuenta como completa si revisó al menos este porcentaje de los recursos. */
const COBERTURA_MINIMA = 0.9;
/** Validaciones que muestran las barras de la página. */
const VALIDACIONES_MATRIZ = 30;

const TIPOS = {
  ok: '',
  timeout: 'Sin respuesta',
  bucle: 'Bucle de redirección',
  dominio: 'Dominio inesperado',
  texto: 'Contenido inesperado',
  denegado: 'Acceso denegado',
  sesion: 'Pantalla de login',
  error: 'Error de conexión',
};

/**
 * En qué etapa del acceso falló un recurso, según dónde terminó la navegación:
 *   proxy  el proxy institucional respondió y redirigió al proveedor
 *   login  no apareció la pantalla de login (sesión institucional válida)
 *   sitio  el proveedor mostró el recurso con acceso de la universidad
 * Una etapa posterior a la que falló queda sin dato (null).
 */
function etapas(r, recurso, loginOk) {
  if (!loginOk) return { proxy: null, login: 'falla', sitio: null };
  if (r.ok) return { proxy: 'ok', login: 'ok', sitio: 'ok' };
  let host = '';
  try {
    host = new URL(r.urlFinal).host;
  } catch {
    // URL de error del navegador
  }
  const hostEntrada = new URL(recurso.url_entrada).host;
  const enProxy = host === PROXY_HOST || host === hostEntrada || host === '' || host === 'chromewebdata';
  switch (r.tipo) {
    case 'sesion':
      return { proxy: 'ok', login: 'falla', sitio: null };
    case 'error':
    case 'timeout':
    case 'dominio':
      // Si la navegación nunca salió del proxy, el proxy no llevó al proveedor.
      return enProxy && recurso.dominio_final !== PROXY_HOST
        ? { proxy: 'falla', login: null, sitio: null }
        : { proxy: 'ok', login: 'ok', sitio: 'falla' };
    default:
      return { proxy: 'ok', login: 'ok', sitio: 'falla' };
  }
}

/** Etapa que falló, para el historial de cada recurso. */
function etapaFallida(e) {
  return e.proxy === 'falla' ? 'proxy' : e.login === 'falla' ? 'login' : e.sitio === 'falla' ? 'sitio' : null;
}

const redondear = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export function generarMetricas(raiz = '.') {
  const recursos = JSON.parse(readFileSync(join(raiz, 'recursos.json'), 'utf8'));
  const porNombre = new Map(recursos.map((r) => [r.nombre, r]));

  const dir = join(raiz, 'registros');
  const validaciones = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((v) => v && v.fecha && Array.isArray(v.resultados))
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .map((v) => ({
      fecha: v.fecha,
      origen: v.origen || 'automatica',
      login: v.login !== false,
      resultados: new Map(v.resultados.filter((r) => porNombre.has(r.nombre)).map((r) => [r.nombre, r])),
    }));

  // Cuentan para el historial las validaciones completas y las que no pudieron iniciar sesión.
  // Las parciales (pruebas de unos pocos recursos) solo actualizan el último estado de esos recursos.
  const completa = (v) => v.login && v.resultados.size >= COBERTURA_MINIMA * recursos.length;
  const enHistorial = validaciones.filter((v) => completa(v) || !v.login);
  const completas = enHistorial.filter(completa);
  const etapasDe = (v, r) => etapas(r, porNombre.get(r.nombre), v.login);

  const historial = enHistorial.map((v) => {
    const resultados = [...v.resultados.values()];
    const tiempos = resultados.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
    const fases = resultados.map((r) => etapasDe(v, r));
    return {
      fecha: v.fecha,
      origen: v.origen,
      sesion: v.login ? 'OK' : 'Falla',
      revisados: resultados.length,
      disponibles: resultados.filter((r) => r.ok).length,
      con_fallas: resultados.filter((r) => !r.ok).length,
      disponibilidad: resultados.length ? redondear(resultados.filter((r) => r.ok).length / resultados.length, 3) : null,
      proxy_ok: fases.filter((e) => e.proxy === 'ok').length,
      sitio_ok: fases.filter((e) => e.sitio === 'ok').length,
      carga_mediana_s: tiempos.length ? redondear(tiempos[Math.floor(tiempos.length / 2)] / 1000, 1) : null,
    };
  });

  const estado = recursos.map((recurso) => {
    let ultimo;
    let validacion;
    for (const v of validaciones) {
      const r = v.resultados.get(recurso.nombre);
      if (r) [ultimo, validacion] = [r, v];
    }
    const propios = completas.map((v) => v.resultados.get(recurso.nombre)).filter(Boolean);
    return {
      recurso: recurso.nombre,
      proveedor: recurso.proveedor,
      url: recurso.url_entrada,
      estado: ultimo ? (ultimo.ok ? 'Disponible' : 'Con falla') : 'Sin revisar',
      etapas: ultimo ? etapasDe(validacion, ultimo) : { proxy: null, login: null, sitio: null },
      falla: ultimo ? TIPOS[ultimo.tipo] ?? ultimo.tipo : '',
      detalle: ultimo?.error ?? '',
      carga_s: ultimo ? redondear(ultimo.ms / 1000, 1) : null,
      revisado: ultimo?.fecha ?? null,
      origen: validacion?.origen ?? null,
      disponibilidad: propios.length ? redondear(propios.filter((r) => r.ok).length / propios.length, 3) : null,
      validaciones: propios.length,
    };
  });

  // Por validación: 1 disponible, 0 con falla, null sin dato; carga en segundos; etapa que falló.
  const ultimas = enHistorial.slice(-VALIDACIONES_MATRIZ);
  const matriz = {
    dias: ultimas.map((v) => v.fecha),
    recursos: recursos.map((recurso) => ({
      recurso: recurso.nombre,
      proveedor: recurso.proveedor,
      estados: ultimas.map((v) => {
        const r = v.resultados.get(recurso.nombre);
        return r ? (r.ok ? 1 : 0) : null;
      }),
      cargas: ultimas.map((v) => {
        const r = v.resultados.get(recurso.nombre);
        return r ? redondear(r.ms / 1000, 1) : null;
      }),
      fallas: ultimas.map((v) => {
        if (!v.login) return 'login';
        const r = v.resultados.get(recurso.nombre);
        return r ? etapaFallida(etapasDe(v, r)) : null;
      }),
    })),
  };

  mkdirSync(join(raiz, 'datos'), { recursive: true });
  writeFileSync(join(raiz, 'datos', 'estado.json'), JSON.stringify(estado, null, 1));
  writeFileSync(join(raiz, 'datos', 'historial.json'), JSON.stringify(historial, null, 1));
  writeFileSync(join(raiz, 'datos', 'matriz.json'), JSON.stringify(matriz));
  return { recursos: estado.length, validaciones: historial.length, completas: completas.length };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const r = generarMetricas(process.argv[2] || '.');
  console.log(`datos: ${r.recursos} recursos · ${r.validaciones} validaciones (${r.completas} completas)`);
}
