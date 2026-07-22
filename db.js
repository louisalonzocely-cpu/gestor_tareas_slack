// ==========================================
// 1. CONFIGURACIÓN Y DEPENDENCIAS
// ==========================================

// Carga las variables de entorno locales desde un archivo .env si no estamos en producción
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// Importación del framework oficial de Slack (Bolt)
const { App, ExpressReceiver } = require('@slack/bolt');

// Funciones para interactuar con la base de datos PostgreSQL (módulo db.js)
const { obtenerTareas, crearTarea, actualizarCompletada } = require('./db');


// ==========================================
// 2. INICIALIZACIÓN Y MIDDLEWARES DE SLACK
// ==========================================

// Configuración del receptor Express personalizado de Bolt
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Define rutas HTTP adicionales directas (como el comprobador de salud para Railway)
  customRoutes: [
    {
      path: '/health',
      method: ['GET'],
      handler: (req, res) => {
        res.writeHead(200);
        res.end('ok'); // Responde 200 OK para confirmar que el servidor está activo
      },
    },
  ],
});

// Creación de la instancia principal de la aplicación de Slack
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});


// ==========================================
// 3. CONSTRUCTOR DE INTERFAZ GRÁFICA (HOME TAB)
// ==========================================

/**
 * Función asíncrona que consulta las tareas en la BD y construye la vista 
 * dinámica del menú Inicio (Home Tab) utilizando los bloques visuales de Slack (Block Kit).
 * 
 * @param {string} userId - ID de Slack del usuario actual.
 * @returns {object} Objeto de vista en formato JSON compatible con Slack API.
 */
async function construirVistaHome(userId) {
  try {
    // Consulta la BD para obtener el listado de tareas del usuario
    const tareas = await obtenerTareas(userId);

    // Separa las tareas en dos grupos según su estado
    const pendientes = tareas ? tareas.filter((t) => !t.completada) : [];
    const completadas = tareas ? tareas.filter((t) => t.completada) : [];

    // Encabezado principal y botón de acción inicial
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
            style: 'primary', // Estilo destacado en verde
            text: { type: 'plain_text', text: '➕ Nueva Tarea', emoji: true },
            action_id: 'abrir_modal_tarea',
          },
        ],
      },
      { type: 'divider' },
    ];

    // --- SECCIÓN: TAREAS PENDIENTES ---
    blocksBase.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📌 Pendientes (${pendientes.length})*` },
    });

    // Caso de uso: Sin pendientes
    if (pendientes.length === 0) {
      blocksBase.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '🎉 _¡No tienes tareas pendientes! Tómate un descanso._' },
      });
    } else {
      // Mapea y renderiza cada tarea pendiente en una tarjeta con su botón de completar
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

      // Mapea las tareas completadas aplicando tachado al título (~texto~)
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

    // Retorna la vista completa estructurada para el Home Tab
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

/**
 * EVENTO: Se ejecuta cuando el usuario abre la pestaña de la App en Slack.
 * Publica la vista Home renderizada con las tareas actualizadas de la BD.
 */
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

/**
 * ACCIÓN: Se ejecuta al presionar el botón "➕ Nueva Tarea".
 * Abre un formulario flotante (modal) para ingresar los datos de la nueva tarea.
 */
app.action('abrir_modal_tarea', async ({ ack, body, client }) => {
  await ack(); // Confirma la recepción de la acción a Slack antes de 3 segundos
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

/**
 * ENVÍO DE VISTA (VIEW SUBMIT): Se ejecuta cuando el usuario presiona "Crear" en el modal.
 * Extrae los valores ingresados, los inserta en Postgres y refresca el Home Tab.
 */
app.view('submit_tarea', async ({ ack, body, view, client }) => {
  await ack();
  const valores = view.state.values;
  const usuario = body.user.id;

  try {
    // Extracción limpia de los inputs introducidos por el usuario
    await crearTarea({
      usuarioId: usuario,
      titulo: valores.titulo_block.titulo_input.value,
      descripcion: valores.descripcion_block.descripcion_input.value || null,
      fecha: valores.fecha_block.fecha_input.selected_date || null,
    });

    // Refresca la interfaz de inicio para mostrar la nueva tarea creada
    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al guardar tarea:', error);
  }
});

/**
 * ACCIÓN: Se ejecuta al presionar "✔ Completar" en una tarea.
 * Cambia el estado de la tarea en la BD a completada (true) y redibuja la vista.
 */
app.action('completar_tarea', async ({ ack, body, client }) => {
  await ack();
  const usuario = body.user.id;
  const tareaId = body.actions[0].value; // Obtiene el ID numérico almacenado en el botón

  try {
    if (tareaId) {
      await actualizarCompletada(tareaId, true);
    }

    // Refresca la vista para mover la tarea a la sección "Completadas"
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
  await app.start(port);
  console.log(`⚡️ App corriendo en el puerto ${port}`);
})();