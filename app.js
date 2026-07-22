// ==========================================
// 1. CONFIGURACIÓN Y DEPENDENCIAS
// ==========================================

// Carga variables de entorno locales si no estamos en producción
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Importación del framework oficial de Slack (Bolt)
const { App, ExpressReceiver } = require('@slack/bolt');

// Funciones para interactuar con la base de datos PostgreSQL
const { obtenerTareas, crearTarea, actualizarCompletada } = require('./db');


// ==========================================
// 2. INICIALIZACIÓN Y MIDDLEWARES DE SLACK
// ==========================================

// Instancia del ExpressReceiver de Bolt con ruta /health integrada para Railway
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  customRoutes: [
    {
      path: '/health',
      method: ['GET'],
      handler: (req, res) => {
        res.writeHead(200);
        res.end('ok'); // Responde OK para confirmar salud del servidor
      },
    },
  ],
});

// Inicialización de la aplicación Slack pasando el receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});


// ==========================================
// 3. CONSTRUCTOR DE INTERFAZ GRÁFICA (HOME TAB)
// ==========================================

/**
 * Consulta las tareas en Postgres y genera la vista dinámica del menú Home Tab.
 * 
 * @param {string} userId - ID de usuario de Slack.
 * @returns {object} Objeto de vista compatible con Slack Block Kit.
 */
async function construirVistaHome(userId) {
  try {
    const tareas = await obtenerTareas(userId);

    // Filtrar tareas por estado
    const pendientes = tareas ? tareas.filter((t) => !t.completada) : [];
    const completadas = tareas ? tareas.filter((t) => t.completada) : [];

    // Encabezado y botón principal
    const blocksBase = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚡️ Centro de Control de Tareas', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `👋 ¡Hola <@${userId}>! Organiza tus pendientes diarios directamente desde esta pestaña.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: '➕ Nueva Tarea', emoji: true },
            action_id: 'abrir_modal_tarea',
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ' ',
          },
        ],
      },
    ];

    // --- SECCIÓN: TAREAS PENDIENTES ---
    blocksBase.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\n\n\n*📌 Pendientes (${pendientes.length})*` },
    });

    if (pendientes.length === 0) {
      blocksBase.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '🎉 _¡No tienes tareas pendientes! Tómate un descanso._' },
      });
    } else {
      pendientes.forEach((tarea) => {
        const fechaTexto = tarea.fecha ? `📅 *Límite:* ${tarea.fecha}` : '📅 *Límite:* Sin fecha';
        const descTexto = tarea.descripcion ? `\n>_${tarea.descripcion}_` : '';

        blocksBase.push({
          type: 'section',
          block_id: `tarea_${tarea.id}`,
          text: {
            type: 'mrkdwn',
            text: `*${tarea.titulo}*${descTexto}\n${fechaTexto}`,
          },
          accessory: {
            type: 'button',
            text: { type: 'plain_text', text: '✔ Completar', emoji: true },
            value: String(tarea.id),
            action_id: 'completar_tarea',
          },
        });
      });
    }

    blocksBase.push({ type: 'divider' });

    // --- SECCIÓN: TAREAS COMPLETADAS ---
    if (completadas.length > 0) {
      blocksBase.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*✅ Completadas (${completadas.length})*` },
      });

      completadas.forEach((tarea) => {
        blocksBase.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `~${tarea.titulo}~`,
          },
        });
      });
    }

    return { type: 'home', blocks: blocksBase };
  } catch (error) {
    console.error('❌ Error al obtener tareas:', error);
    return {
      type: 'home',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '⚠️ Ocurrió un error al cargar tus tareas.' },
        },
      ],
    };
  }
}


// ==========================================
// 4. CONTROLADORES DE EVENTOS Y ACCIONES
// ==========================================

// Evento: Al abrir la pestaña de la App en Slack
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: await construirVistaHome(event.user),
    });
  } catch (error) {
    console.error('❌ Error en app_home_opened:', error);
  }
});

// Acción: Botón "➕ Nueva Tarea" abre el modal
app.action('abrir_modal_tarea', async ({ ack, body, client }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_tarea',
        title: { type: 'plain_text', text: 'Nueva Tarea' },
        submit: { type: 'plain_text', text: 'Crear' },
        close: { type: 'plain_text', text: 'Cancelar' },
        blocks: [
          {
            type: 'input',
            block_id: 'titulo_block',
            label: { type: 'plain_text', text: 'Título de la tarea' },
            element: {
              type: 'plain_text_input',
              action_id: 'titulo_input',
              placeholder: { type: 'plain_text', text: 'Ej. Revisar propuesta de cliente' },
            },
          },
          {
            type: 'input',
            block_id: 'descripcion_block',
            label: { type: 'plain_text', text: 'Descripción' },
            optional: true,
            element: { type: 'plain_text_input', action_id: 'descripcion_input', multiline: true },
          },
          {
            type: 'input',
            block_id: 'fecha_block',
            label: { type: 'plain_text', text: 'Fecha límite' },
            optional: true,
            element: {
              type: 'datepicker',
              action_id: 'fecha_input',
              placeholder: { type: 'plain_text', text: 'Selecciona una fecha' },
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('❌ Error al abrir modal:', error);
  }
});

// Modal Submit: Guardar la tarea en la base de datos
app.view('submit_tarea', async ({ ack, body, view, client }) => {
  await ack();
  const valores = view.state.values;
  const usuario = body.user.id;

  try {
    await crearTarea({
      usuarioId: usuario,
      titulo: valores.titulo_block.titulo_input.value,
      descripcion: valores.descripcion_block.descripcion_input.value || null,
      fecha: valores.fecha_block.fecha_input.selected_date || null,
    });

    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al guardar tarea:', error);
  }
});

// Acción: Botón "✔ Completar" cambia el estado en la BD
app.action('completar_tarea', async ({ ack, body, client }) => {
  await ack();
  const usuario = body.user.id;
  const tareaId = body.actions[0].value;

  try {
    if (tareaId) {
      await actualizarCompletada(tareaId, true);
    }

    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al actualizar tarea:', error);
  }
});


// ==========================================
// 5. INICIO DEL SERVIDOR
// ==========================================

(async () => {
  const port = process.env.PORT || 3000;
  // Usamos receiver.start() para evitar el conflicto de doble puerto en Railway
  await receiver.start(port);
  console.log(`⚡️ App corriendo en el puerto ${port}`);
})();