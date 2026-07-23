const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function obtenerTareas(usuarioId) {
  const { rows } = await pool.query(
    'SELECT * FROM tareas WHERE usuario_id = $1 ORDER BY creada_en ASC',
    [usuarioId]
  );
  return rows;
}

async function crearTarea({ usuarioId, titulo, descripcion, fecha }) {
  const { rows } = await pool.query(
    `INSERT INTO tareas (usuario_id, titulo, descripcion, fecha)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [usuarioId, titulo, descripcion, fecha]
  );
  return rows[0];
}

async function actualizarCompletada(tareaId, completada) {
  await pool.query('UPDATE tareas SET completada = $1 WHERE id = $2', [completada, tareaId]);
}

// Obtiene tareas completadas con paginación (LIMIT/OFFSET)
async function obtenerTareasCompletadas(usuarioId, limite, offset) {
  const { rows } = await pool.query(
    'SELECT * FROM tareas WHERE usuario_id = $1 AND completada = true ORDER BY creada_en DESC LIMIT $2 OFFSET $3',
    [usuarioId, limite, offset]
  );
  return rows;
}

// Cuenta el total de tareas completadas para calcular páginas
async function contarTareasCompletadas(usuarioId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) as total FROM tareas WHERE usuario_id = $1 AND completada = true',
    [usuarioId]
  );
  return parseInt(rows[0].total, 10);
}

// Obtiene una tarea por su ID
async function obtenerTareaPorId(tareaId) {
  const { rows } = await pool.query('SELECT * FROM tareas WHERE id = $1', [tareaId]);
  return rows[0];
}

// Actualiza una tarea existente
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