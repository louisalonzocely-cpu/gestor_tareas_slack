// ==========================================
// db.js - Capa de acceso a datos
// ==========================================
// Este archivo encapsula todas las consultas SQL a PostgreSQL.
// Cada función maneja una operación específica sobre la tabla 'tareas'.
// Se usa el pool de conexiones de "pg" para gestionar conexiones eficientemente.

const { Pool } = require('pg');

// Pool de conexiones: reutiliza conexiones en vez de abrir una nueva por cada query.
// connectionString: URL completa de la BD (viene de DATABASE_URL en .env o el entorno).
// ssl: en producción (Railway) requiere SSL; en desarrollo local se desactiva.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// --- OBTENER TODAS LAS TAREAS DE UN USUARIO ---
// Retorna pendientes + completadas ordenadas por fecha de creación (las más viejas primero).
// Se usa en la Home Tab para filtrar pendientes vs completadas en memoria.
async function obtenerTareas(usuarioId) {
  const { rows } = await pool.query(
    'SELECT * FROM tareas WHERE usuario_id = $1 ORDER BY creada_en ASC',
    [usuarioId]
  );
  return rows;
}

// --- CREAR UNA NUEVA TAREA ---
// Recibe un objeto con los datos y retorna la tarea recién creada (RETURNING *).
// INSERT con 4 columnas: usuario_id, titulo, descripcion, fecha.
async function crearTarea({ usuarioId, titulo, descripcion, fecha }) {
  const { rows } = await pool.query(
    `INSERT INTO tareas (usuario_id, titulo, descripcion, fecha)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [usuarioId, titulo, descripcion, fecha]
  );
  return rows[0];
}

// --- MARCAR TAREA COMO COMPLETADA/NO COMPLETADA ---
// Cambia el booleano "completada" de una tarea.
// Se llama con completada=true al hacer clic en "Completar".
async function actualizarCompletada(tareaId, completada) {
  await pool.query('UPDATE tareas SET completada = $1 WHERE id = $2', [completada, tareaId]);
}

// --- OBTENER TAREAS COMLETADAS CON PAGINACIÓN ---
// Usa LIMIT y OFFSET para traer solo una "página" de resultados.
// limite = cuántas traer (TAREAS_POR_PAGINA = 3)
// offset = cuántas saltar (calculada en construirVistaHome)
async function obtenerTareasCompletadas(usuarioId, limite, offset) {
  const { rows } = await pool.query(
    'SELECT * FROM tareas WHERE usuario_id = $1 AND completada = true ORDER BY creada_en DESC LIMIT $2 OFFSET $3',
    [usuarioId, limite, offset]
  );
  return rows;
}

// --- CONTAR TAREAS COMPLETADAS ---
// Retorna el número total de tareas completadas de un usuario.
// Se usa para calcular cuántas páginas de paginación hay.
async function contarTareasCompletadas(usuarioId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as total FROM tareas WHERE usuario_id = $1 AND completada = true',
    [usuarioId]
  );
  return parseInt(rows[0].total, 10);
}

// --- OBTENER UNA TAREA POR ID ---
// Busca una tarea específica sin filtrar por usuario (el ID es único/global).
// Se usa en el handler de edición para pre-cargar los datos en el modal.
async function obtenerTareaPorId(tareaId) {
  const { rows } = await pool.query('SELECT * FROM tareas WHERE id = $1', [tareaId]);
  return rows[0];
}

// --- ACTUALIZAR UNA TAREA EXISTENTE ---
// Actualiza título, descripción y fecha de una tarea.
// Usa COALESCE($1, titulo): si el valor es null, mantiene el valor actual.
// Esto permite actualizar solo campos específicos sin tocar los demás.
async function actualizarTarea(tareaId, { titulo, descripcion, fecha }) {
  const { rows } = await pool.query(
    `UPDATE tareas 
     SET titulo = COALESCE($1, titulo), 
         descripcion = COALESCE($2, descripcion), 
         fecha = $3
     WHERE id = $4 
     RETURNING *`,
    [titulo, descripcion, fecha, tareaId]
  );
  return rows[0];
}

module.exports = { 
  obtenerTareas, 
  crearTarea, 
  actualizarCompletada, 
  obtenerTareasCompletadas, 
  contarTareasCompletadas,
  obtenerTareaPorId,
  actualizarTarea
};