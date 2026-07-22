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

module.exports = { obtenerTareas, crearTarea, actualizarCompletada };