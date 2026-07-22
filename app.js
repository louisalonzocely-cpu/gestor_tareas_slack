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
const { obtenerTareas, crearTarea, actualizarCompletada, obtenerTareasCompletadas, contarTareasCompletadas } = require('./db');


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
 * @param {number} paginaCompletadas - Página actual de tareas completadas (default: 1).
 * @returns {object} Objeto de vista compatible con Slack Block Kit.
 */
async function construirVistaHome(userId, paginaCompletadas = 1) {
  // Constantes para paginación
  const TAREAS_POR_PAGINA = 5;
  const offset = (paginaCompletadas - 1) * TAREAS_POR_PAGINA;

  try {
    // Consultar tareas pendientes (todas) y completadas (paginadas)
    const tareas = await obtenerTareas(userId);
    const pendientes = tareas ? tareas.filter((t) => !t.completada) : [];
    
    // Obtener tareas completadas paginadas y el total para calcular páginas
    const completadas = await obtenerTareasCompletadas(userId, TAREAS_POR_PAGINA, offset);
    const totalCompletadas = await contarTareasCompletadas(userId);
    const totalPaginas = Math.ceil(totalCompletadas / TAREAS_POR_PAGINA);

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
      { type: 'context', elements: [{ type: 'mrkdwn', text: ' ' }] },
    ];

    // --- SECCIÓN: TAREAS PENDIENTES ---
    // Agregamos un doble salto de línea antes del título
    blocksBase.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📌 Pendientes (${pendientes.length})*` },
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
    blocksBase.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ' ' }] });

    // --- SECCIÓN: TAREAS COMPLETADAS (CON TABLA Y PAGINACIÓN) ---
    blocksBase.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*✅ Completadas (${totalCompletadas})*` },
    });

    if (completadas.length === 0) {
      // Mensaje cuando no hay tareas completadas
      blocksBase.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_Aún no has completado ninguna tarea._' },
      });
    } else {
      // Renderizar cada tarea completada con todos sus detalles
      completadas.forEach((tarea) => {
        const fechaLimite = tarea.fecha ? `📅 *Límite:* ${tarea.fecha}` : '📅 *Límite:* Sin fecha';
        const descripcion = tarea.descripcion ? `\n>_${tarea.descripcion}_` : '';
        const fechaCreacion = tarea.creada_en 
          ? `🕐 *Creada:* ${new Date(tarea.creada_en).toLocaleDateString('es-ES')}` 
          : '';

        // Bloque principal con título, descripción y fecha límite
        blocksBase.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `~*${tarea.titulo}*~${descripcion}\n${fechaLimite}`,
          },
        });

        // Contexto con fecha de creación (más Details)
        if (fechaCreacion) {
          blocksBase.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: fechaCreacion }],
          });
        }
      });

      // Controles de paginación (solo si hay más de una página)
      if (totalPaginas > 1) {
        const elementosPaginacion = [];

        // Botón "Anterior" (deshabilitado si estamos en la primera página)
        if (paginaCompletadas > 1) {
          elementosPaginacion.push({
            type: 'button',
            text: { type: 'plain_text', text: '◀ Anterior', emoji: true },
            value: String(paginaCompletadas - 1),
            action_id: 'completadas_anterior',
          });
        }

        // Indicador de página actual
        elementosPaginacion.push({
          type: 'button',
          text: { type: 'plain_text', text: `Página ${paginaCompletadas} de ${totalPaginas}`, emoji: true },
          action_id: 'paginas_indicator',
        });

        // Botón "Siguiente" (deshabilitado si estamos en la última página)
        if (paginaCompletadas < totalPaginas) {
          elementosPaginacion.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Siguiente ▶', emoji: true },
            value: String(paginaCompletadas + 1),
            action_id: 'completadas_siguiente',
          });
        }

        blocksBase.push({
          type: 'actions',
          elements: elementosPaginacion,
        });
      }
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

// Acción: Botón "Nueva Tarea" abre el modal
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

// Acción: Botón "Completar" cambia el estado en la BD
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

// Acción: Botón "Anterior" en paginación de completadas
app.action('completadas_anterior', async ({ ack, body, client }) => {
  await ack();
  const usuario = body.user.id;
  const pagina = parseInt(body.actions[0].value, 10);

  try {
    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario, pagina),
    });
  } catch (error) {
    console.error('❌ Error al cambiar página:', error);
  }
});

// Acción: Botón "Siguiente" en paginación de completadas
app.action('completadas_siguiente', async ({ ack, body, client }) => {
  await ack();
  const usuario = body.user.id;
  const pagina = parseInt(body.actions[0].value, 10);

  try {
    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario, pagina),
    });
  } catch (error) {
    console.error('❌ Error al cambiar página:', error);
  }
});

// Acción: Botón indicador de página (solo visual, no hace nada)
app.action('paginas_indicator', async ({ ack }) => {
  await ack();
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