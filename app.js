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
const { 
  obtenerTareas, 
  crearTarea, 
  actualizarCompletada, 
  obtenerTareasCompletadas, 
  contarTareasCompletadas,
  obtenerTareaPorId,
  actualizarTarea
} = require('./db');


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
  const TAREAS_POR_PAGINA = 3;
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
        // Formatear fecha límite con hora si está disponible
        let fechaTexto = '📅 *Límite:* Sin fecha';
        if (tarea.fecha) {
          const fecha = new Date(tarea.fecha);
          fechaTexto = `📅 *Límite:* ${fecha.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
          if (fecha.getHours() !== 0 || fecha.getMinutes() !== 0) {
            fechaTexto += ` a las ${fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
          }
        }
        
        const descTexto = tarea.descripcion ? `\n>_${tarea.descripcion}_` : '';

        // Sección con título y descripción
        blocksBase.push({
          type: 'section',
          block_id: `tarea_${tarea.id}`,
          text: {
            type: 'mrkdwn',
            text: `*${tarea.titulo}*${descTexto}\n${fechaTexto}`,
          },
        });

        // Botones de acción: Completar y Editar
        blocksBase.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✔ Completar', emoji: true },
              value: String(tarea.id),
              action_id: 'completar_tarea',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '✏️ Editar', emoji: true },
              value: String(tarea.id),
              action_id: 'editar_tarea',
            },
          ],
        });
      });
    }

    blocksBase.push({ type: 'divider' });
    blocksBase.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ' ' }] });

    // --- SECCIÓN: TAREAS COMPLETADAS (LISTA COMPACTA) ---
    blocksBase.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*✅ Completadas (${totalCompletadas})*` },
    });

    if (completadas.length === 0) {
      blocksBase.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '_Aún no has completado ninguna tarea._' },
      });
    } else {
      // Lista compacta: una línea por tarea usando context blocks
      completadas.forEach((tarea) => {
        let fechaLimite = '';
        if (tarea.fecha) {
          const fecha = new Date(tarea.fecha);
          fechaLimite = ` | ${fecha.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}`;
          if (fecha.getHours() !== 0 || fecha.getMinutes() !== 0) {
            fechaLimite += ` ${fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
          }
        }

        blocksBase.push({
          type: 'context',
          elements: [{ 
            type: 'mrkdwn', 
            text: `~• ${tarea.titulo}${fechaLimite}~` 
          }],
        });
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
          {
            type: 'input',
            block_id: 'hora_block',
            label: { type: 'plain_text', text: 'Hora límite' },
            optional: true,
            element: {
              type: 'timepicker',
              action_id: 'hora_input',
              placeholder: { type: 'plain_text', text: 'Selecciona una hora' },
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

  // Combinar fecha y hora en un solo timestamp
  const fechaSeleccionada = valores.fecha_block.fecha_input.selected_date;
  const horaSeleccionada = valores.hora_block.hora_input.selected_time;
  
  let fechaCompleta = null;
  if (fechaSeleccionada) {
    // Si hay hora seleccionada, combinarlas; si no, usar solo la fecha con hora 00:00
    const hora = horaSeleccionada || '00:00';
    fechaCompleta = `${fechaSeleccionada}T${hora}:00`;
  }

  try {
    await crearTarea({
      usuarioId: usuario,
      titulo: valores.titulo_block.titulo_input.value,
      descripcion: valores.descripcion_block.descripcion_input.value || null,
      fecha: fechaCompleta,
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

// Acción: Botón "Editar" abre modal con datos de la tarea
app.action('editar_tarea', async ({ ack, body, client }) => {
  await ack();
  const tareaId = body.actions[0].value;

  try {
    // Obtener datos actuales de la tarea
    const tarea = await obtenerTareaPorId(tareaId);
    if (!tarea) return;

    // Preparar fecha y hora para los selectores
    let fechaInicial = undefined;
    let horaInicial = undefined;
    if (tarea.fecha) {
      const fecha = new Date(tarea.fecha);
      fechaInicial = fecha.toISOString().split('T')[0]; // YYYY-MM-DD
      // Solo mostrar hora si no es medianoche
      if (fecha.getHours() !== 0 || fecha.getMinutes() !== 0) {
        horaInicial = `${String(fecha.getHours()).padStart(2, '0')}:${String(fecha.getMinutes()).padStart(2, '0')}`;
      }
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_edicion',
        private_metadata: tareaId,
        title: { type: 'plain_text', text: 'Editar Tarea' },
        submit: { type: 'plain_text', text: 'Guardar' },
        close: { type: 'plain_text', text: 'Cancelar' },
        blocks: [
          {
            type: 'input',
            block_id: 'titulo_block',
            label: { type: 'plain_text', text: 'Título de la tarea' },
            element: {
              type: 'plain_text_input',
              action_id: 'titulo_input',
              initial_value: tarea.titulo,
            },
          },
          {
            type: 'input',
            block_id: 'descripcion_block',
            label: { type: 'plain_text', text: 'Descripción' },
            optional: true,
            element: {
              type: 'plain_text_input',
              action_id: 'descripcion_input',
              multiline: true,
              initial_value: tarea.descripcion || '',
            },
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
              ...(fechaInicial && { initial_date: fechaInicial }),
            },
          },
          {
            type: 'input',
            block_id: 'hora_block',
            label: { type: 'plain_text', text: 'Hora límite' },
            optional: true,
            element: {
              type: 'timepicker',
              action_id: 'hora_input',
              placeholder: { type: 'plain_text', text: 'Selecciona una hora' },
              ...(horaInicial && { initial_time: horaInicial }),
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('❌ Error al abrir edición:', error);
  }
});

// Modal Submit: Guardar edición de tarea
app.view('submit_edicion', async ({ ack, body, view, client }) => {
  await ack();
  const tareaId = view.private_metadata;
  const valores = view.state.values;
  const usuario = body.user.id;

  // Combinar fecha y hora en un solo timestamp
  const fechaSeleccionada = valores.fecha_block.fecha_input.selected_date;
  const horaSeleccionada = valores.hora_block.hora_input.selected_time;
  
  let fechaCompleta = null;
  if (fechaSeleccionada) {
    const hora = horaSeleccionada || '00:00';
    fechaCompleta = `${fechaSeleccionada}T${hora}:00`;
  }

  try {
    await actualizarTarea(tareaId, {
      titulo: valores.titulo_block.titulo_input.value,
      descripcion: valores.descripcion_block.descripcion_input.value || null,
      fecha: fechaCompleta,
    });

    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al guardar edición:', error);
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