// ==========================================
// 1. CONFIGURACIÓN Y DEPENDENCIAS
// ==========================================
// Este archivo es el punto de entrada de la aplicación. Configura el bot de Slack
// usando el framework Bolt, conecta con PostgreSQL y define todas las interacciones
// del usuario: crear, editar, completar tareas y paginación de historial.

// Carga variables de entorno desde el archivo .env en desarrollo local.
// En producción (Railway, Heroku, etc.) las variables ya están en el entorno del sistema.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

// ExpressReceiver permite que la app Slack también sirva rutas HTTP adicionales
// como el endpoint /health, útil para que Railway verifique que el servicio está vivo.
const { App, ExpressReceiver } = require('@slack/bolt');

// Funciones de acceso a datos (db.js) que encapsulan todas las consultas SQL.
// Cada función se encarga de una operación específica sobre la tabla 'tareas'.
const { 
  obtenerTareas,       // Trae todas las tareas (pendientes + completadas) de un usuario
  crearTarea,          // Inserta una nueva tarea en la BD
  actualizarCompletada, // Cambia el estado completada=true/false de una tarea
  obtenerTareasCompletadas, // Trae tareas completadas con paginación (LIMIT/OFFSET)
  contarTareasCompletadas,  // Cuenta el total de completadas (para saber cuántas páginas hay)
  obtenerTareaPorId,   // Busca una tarea específica por su ID (para el modal de edición)
  actualizarTarea      // Actualiza título, descripción y fecha de una tarea existente
} = require('./db');


// ==========================================
// 2. INICIALIZACIÓN Y MIDDLEWARES DE SLACK
// ==========================================
// Se configura el receiver (receptor de peticiones) y la instancia principal
// de la app Bolt. El receiver maneja la comunicación HTTP con Slack.

const receiver = new ExpressReceiver({
  // Secret compartido con Slack para firmar y validar que las peticiones
  // realmente provienen de Slack (seguridad contra falsificación de requests).
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Ruta personalizada /health: Railway hace ping periódico a esta URL para
  // saber si el servicio sigue activo. Si no responde, reinicia el contenedor.
  customRoutes: [
    {
      path: '/health',
      method: ['GET'],
      handler: (req, res) => {
        res.writeHead(200);
        res.end('ok');
      },
    },
  ],
});

// Se crea la app Bolt pasando el receiver customizado.
// Bolt se encarga de: recibir eventos de Slack, despacharlos a los handlers,
// y manejar la autenticación automática con el token del bot.
const app = new App({
  token: process.env.SLACK_BOT_TOKEN, // Token del bot de Slack (xoxb-...)
  receiver,
});


// ==========================================
// 3. CONSTRUCTOR DE INTERFAZ GRÁFICA (HOME TAB)
// ==========================================
// La Home Tab es la pantalla principal que ve el usuario al hacer clic en la app
// dentro de Slack. Esta función construye dinámicamente esa vista usando Block Kit
// (el sistema de UI de Slack) combinando secciones de texto, botones y divisores.

/**
 * Consulta las tareas en Postgres y genera la vista dinámica del menú Home Tab.
 * 
 * Flujo:
 * 1. Pide todas las tareas del usuario a la BD
 * 2. Filtra pendientes vs completadas
 * 3. Calcula la paginación para completadas (3 por página)
 * 4. Arma un array de "blocks" (bloques de UI) que Slack renderiza
 * 
 * @param {string} userId - ID de usuario de Slack (empieza con U0xxxx).
 * @param {number} paginaCompletadas - Página actual de tareas completadas (default: 1).
 * @returns {object} Objeto de vista compatible con Slack Block Kit.
 *                   Ejemplo: { type: 'home', blocks: [...] }
 */
async function construirVistaHome(userId, paginaCompletadas = 1) {
  // Cantidad de tareas completadas que se muestran por página
  const TAREAS_POR_PAGINA = 3;
  // Offset para la consulta SQL: salta las páginas anteriores
  const offset = (paginaCompletadas - 1) * TAREAS_POR_PAGINA;

  try {
    // Consultas a la base de datos:
    // - obtenerTareas: todas las tareas del usuario (pendientes + completadas)
    // - obtenerTareasCompletadas: solo completadas, paginadas con LIMIT/OFFSET
    // - contarTareasCompletadas: total para calcular cuántas páginas existen
    const tareas = await obtenerTareas(userId);
    const pendientes = tareas ? tareas.filter((t) => !t.completada) : [];
    const completadas = await obtenerTareasCompletadas(userId, TAREAS_POR_PAGINA, offset);
    const totalCompletadas = await contarTareasCompletadas(userId);
    const totalPaginas = Math.ceil(totalCompletadas / TAREAS_POR_PAGINA);

    // --- BLOQUES ESTÁTICOS (siempre se muestran) ---
    // Se arma un array con los bloques base: encabezado, saludo, botón de nueva tarea
    const blocksBase = [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚡️ Centro de Control de Tareas', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          // Menciona al usuario usando <@USER_ID> (Slack resuelve el nombre automáticamente)
          text: `👋 ¡Hola <@${userId}>! Organiza tus pendientes diarios directamente desde esta pestaña.`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary', // Botón azul destacado
            text: { type: 'plain_text', text: '➕ Nueva Tarea', emoji: true },
            // action_id: identificador único que usa Bolt para despachar el handler
            action_id: 'abrir_modal_tarea',
          },
        ],
      },
      { type: 'divider' }, // Línea separadora visual
      { type: 'context', elements: [{ type: 'mrkdwn', text: ' ' }] }, // Espaciado
    ];

    // --- SECCIÓN: TAREAS PENDIENTES ---
    // Sección dinámica: se llena con cada tarea que no está completada
    blocksBase.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📌 Pendientes (${pendientes.length})*` },
    });

    if (pendientes.length === 0) {
      // Mensaje amigable cuando no hay tareas pendientes
      blocksBase.push({
        type: 'section',
        text: { type: 'mrkdwn', text: '🎉 _¡No tienes tareas pendientes! Tómate un descanso._' },
      });
    } else {
      // Por cada tarea pendiente se crean 2 bloques:
      // 1. Sección de texto con título, descripción y fecha límite
      // 2. Acciones con botones "Completar" y "Editar"
      pendientes.forEach((tarea) => {
        // Formatear fecha: si tiene hora distinta de 00:00 la incluye
        let fechaTexto = '📅 *Límite:* Sin fecha';
        if (tarea.fecha) {
          const fecha = new Date(tarea.fecha);
          fechaTexto = `📅 *Límite:* ${fecha.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
          // Solo muestra la hora si no es medianoche (00:00)
          if (fecha.getHours() !== 0 || fecha.getMinutes() !== 0) {
            fechaTexto += ` a las ${fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
          }
        }
        
        // Descripción opcional: si existe, se muestra en bloque de cita (>')
        const descTexto = tarea.descripcion ? `\n>_${tarea.descripcion}_` : '';

        // Bloque de texto con la información de la tarea
        blocksBase.push({
          type: 'section',
          block_id: `tarea_${tarea.id}`, // ID único para referencia interna
          text: {
            type: 'mrkdwn',
            text: `*${tarea.titulo}*${descTexto}\n${fechaTexto}`,
          },
        });

        // Botones de acción: cada uno envía el ID de la tarea como "value"
        blocksBase.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✔ Completar', emoji: true },
              value: String(tarea.id), // Se usa para identificar la tarea en el handler
              action_id: 'completar_tarea', // Despacha al handler correspondiente
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

    // Separador visual entre pendientes y completadas
    blocksBase.push({ type: 'divider' });
    blocksBase.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ' ' }] });

    // --- SECCIÓN: TAREAS COMPLETADAS (LISTA COMPACTA) ---
    // Se muestra en formato reducido (una línea por tarea tachada con ~)
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
      // Lista compacta: cada tarea completada se muestra como una línea tachada (~)
      completadas.forEach((tarea) => {
        // Construir texto de fecha (solo día/mes, sin año para ahorrar espacio)
        let fechaLimite = '';
        if (tarea.fecha) {
          const fecha = new Date(tarea.fecha);
          fechaLimite = ` | ${fecha.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}`;
          if (fecha.getHours() !== 0 || fecha.getMinutes() !== 0) {
            fechaLimite += ` ${fecha.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
          }
        }

        // type 'context' muestra texto en tamaño pequeño y gris
        // El formato ~texto~ en mrkdwn tacha el texto (strikethrough)
        blocksBase.push({
          type: 'context',
          elements: [{ 
            type: 'mrkdwn', 
            text: `~• ${tarea.titulo}${fechaLimite}~` 
          }],
        });
      });

      // --- CONTROLES DE PAGINACIÓN ---
      // Solo se muestran si hay más de 1 página de completadas
      if (totalPaginas > 1) {
        const elementosPaginacion = [];

        // Botón "Anterior": solo aparece si NO estamos en la primera página
        // El value contiene el número de página destino
        if (paginaCompletadas > 1) {
          elementosPaginacion.push({
            type: 'button',
            text: { type: 'plain_text', text: '◀ Anterior', emoji: true },
            value: String(paginaCompletadas - 1),
            action_id: 'completadas_anterior',
          });
        }

        // Indicador de página actual: botón visual que muestra "Página X de Y"
        // No tiene handler real, solo es informativo
        elementosPaginacion.push({
          type: 'button',
          text: { type: 'plain_text', text: `Página ${paginaCompletadas} de ${totalPaginas}`, emoji: true },
          action_id: 'paginas_indicator',
        });

        // Botón "Siguiente": solo aparece si NO estamos en la última página
        if (paginaCompletadas < totalPaginas) {
          elementosPaginacion.push({
            type: 'button',
            text: { type: 'plain_text', text: 'Siguiente ▶', emoji: true },
            value: String(paginaCompletadas + 1),
            action_id: 'completadas_siguiente',
          });
        }

        // Se agrega el bloque de acciones con los botones de paginación
        blocksBase.push({
          type: 'actions',
          elements: elementosPaginacion,
        });
      }
    }

    // Retorna el objeto de vista que Slack espera para la Home Tab
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
// Esta sección contiene los handlers que reaccionan a eventos y acciones de Slack.
// Cada handler se registra con Bolt usando app.event() o app.action().
// Dentro de cada handler, "ack()" DEBE llamarse para confirmar a Slack que
// recibimos el evento (si no, Slack reintenta el envío varias veces).

// --- EVENTO: app_home_opened ---
// Se dispara cuando el usuario hace clic en la pestaña "Home" de la app en Slack.
// Es el punto de entrada principal de la interfaz: construye y publica la vista.
app.event('app_home_opened', async ({ event, client }) => {
  try {
    // client.views.publish() envía/actualiza la vista de la Home Tab del usuario.
    // event.user contiene el ID del usuario que abrió la pestaña.
    await client.views.publish({
      user_id: event.user,
      view: await construirVistaHome(event.user),
    });
  } catch (error) {
    console.error('❌ Error en app_home_opened:', error);
  }
});

// --- ACCIÓN: abrir_modal_tarea ---
// Se dispara al hacer clic en el botón "➕ Nueva Tarea" en la Home Tab.
// Abre un modal (ventana superpuesta) con un formulario para crear una tarea.
app.action('abrir_modal_tarea', async ({ ack, body, client }) => {
  await ack(); // Confirma la acción a Slack inmediatamente
  try {
    // client.views.open() muestra un modal al usuario.
    // trigger_id: token temporal que Slack provee para abrir modales (expira en ~3s).
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_tarea', // ID que identifica este modal al enviarse
        title: { type: 'plain_text', text: 'Nueva Tarea' },
        submit: { type: 'plain_text', text: 'Crear' },   // Botón de envío
        close: { type: 'plain_text', text: 'Cancelar' },  // Botón de cierre
        blocks: [
          // Campo obligatorio: título de la tarea
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
          // Campo opcional: descripción (multiline permite texto largo)
          {
            type: 'input',
            block_id: 'descripcion_block',
            label: { type: 'plain_text', text: 'Descripción' },
            optional: true,
            element: { type: 'plain_text_input', action_id: 'descripcion_input', multiline: true },
          },
          // Campo opcional: datepicker para seleccionar fecha límite
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
          // Campo opcional: timepicker para seleccionar hora límite
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

// --- MODAL SUBMIT: submit_tarea ---
// Se dispara cuando el usuario envía el modal de "Nueva Tarea".
// extrae los valores del formulario, los combina y guarda en PostgreSQL.
app.view('submit_tarea', async ({ ack, body, view, client }) => {
  await ack();
  // view.state.values contiene los valores de cada campo del modal,
  // organizados por block_id -> action_id -> valor
  const valores = view.state.values;
  const usuario = body.user.id;

  // Combinación de fecha + hora en un solo timestamp ISO 8601.
  // Si el usuario solo puso fecha (sin hora), se usa 00:00 por defecto.
  const fechaSeleccionada = valores.fecha_block?.fecha_input?.selected_date || null;
  const horaSeleccionada = valores.hora_block?.hora_input?.selected_time || null;
  
  let fechaCompleta = null;
  if (fechaSeleccionada) {
    const hora = horaSeleccionada || '00:00';
    // Formato: "2025-07-20T14:30:00" (compatible con PostgreSQL timestamp)
    fechaCompleta = `${fechaSeleccionada}T${hora}:00`;
  }

  try {
    // Inserta la tarea en la BD con los datos del formulario
    await crearTarea({
      usuarioId: usuario,
      titulo: valores.titulo_block.titulo_input.value,
      descripcion: valores.descripcion_block?.descripcion_input?.value || null,
      fecha: fechaCompleta,
    });

    // Reconstruye y publica la Home Tab actualizada (la nueva tarea aparecerá)
    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al guardar tarea:', error);
  }
});

// --- ACCIÓN: completar_tarea ---
// Se dispara al hacer clic en el botón "✔ Completar" de una tarea pendiente.
// Marca la tarea como completada en la BD y refresca la Home Tab.
app.action('completar_tarea', async ({ ack, body, client }) => {
  await ack();
  const usuario = body.user.id;
  // body.actions[0].value contiene el ID de la tarea (seteado en el botón)
  const tareaId = body.actions[0].value;

  try {
    if (tareaId) {
      // Cambia el campo "completada" a true en PostgreSQL
      await actualizarCompletada(tareaId, true);
    }

    // Refresca la Home Tab para que la tarea desaparezca de pendientes
    // y aparezca en completadas
    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al actualizar tarea:', error);
  }
});

// --- ACCIÓN: editar_tarea ---
// Se dispara al hacer clic en el botón "✏️ Editar" de una tarea pendiente.
// Abre un modal pre-cargado con los datos actuales de la tarea para modificarlos.
app.action('editar_tarea', async ({ ack, body, client }) => {
  await ack();
  const tareaId = body.actions[0].value;

  try {
    // Busca la tarea completa en la BD por su ID
    const tarea = await obtenerTareaPorId(tareaId);
    if (!tarea) return; // Si no existe (borrada?), no hace nada

    // Convierte la fecha de la BD a formato compatible con los selectores de Slack.
    // - fechaInicial: "YYYY-MM-DD" para el datepicker
    // - horaInicial: "HH:MM" para el timepicker (solo si no es 00:00)
    let fechaInicial = undefined;
    let horaInicial = undefined;
    if (tarea.fecha) {
      const fecha = new Date(tarea.fecha);
      fechaInicial = fecha.toISOString().split('T')[0];
      if (fecha.getHours() !== 0 || fecha.getMinutes() !== 0) {
        horaInicial = `${String(fecha.getHours()).padStart(2, '0')}:${String(fecha.getMinutes()).padStart(2, '0')}`;
      }
    }

    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_edicion',
        private_metadata: tareaId, // Guarda el ID de la tarea para usarlo al enviar
        title: { type: 'plain_text', text: 'Editar Tarea' },
        submit: { type: 'plain_text', text: 'Guardar' },
        close: { type: 'plain_text', text: 'Cancelar' },
        blocks: [
          // Los campos son idénticos al modal de creación pero con initial_value
          // que pre-carga los datos actuales de la tarea
          {
            type: 'input',
            block_id: 'titulo_block',
            label: { type: 'plain_text', text: 'Título de la tarea' },
            element: {
              type: 'plain_text_input',
              action_id: 'titulo_input',
              initial_value: tarea.titulo, // Valor actual de la tarea
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
              ...(fechaInicial && { initial_date: fechaInicial }), // Fecha actual
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
              ...(horaInicial && { initial_time: horaInicial }), // Hora actual
            },
          },
        ],
      },
    });
  } catch (error) {
    console.error('❌ Error al abrir edición:', error);
  }
});

// --- MODAL SUBMIT: submit_edicion ---
// Se dispara cuando el usuario envía el modal de edición.
// Actualiza los campos de la tarea en la BD y refresca la Home Tab.
app.view('submit_edicion', async ({ ack, body, view, client }) => {
  await ack();
  // private_metadata contiene el ID de la tarea (se guardó al abrir el modal)
  const tareaId = view.private_metadata;
  const valores = view.state.values;
  const usuario = body.user.id;

  // Combina fecha + hora igual que en la creación
  const fechaSeleccionada = valores.fecha_block.fecha_input.selected_date;
  const horaSeleccionada = valores.hora_block.hora_input.selected_time;
  
  let fechaCompleta = null;
  if (fechaSeleccionada) {
    const hora = horaSeleccionada || '00:00';
    fechaCompleta = `${fechaSeleccionada}T${hora}:00`;
  }

  try {
    // Actualiza solo los campos modificados (usa COALESCE en SQL para mantener
    // los valores originales si el campo viene vacío)
    await actualizarTarea(tareaId, {
      titulo: valores.titulo_block.titulo_input.value,
      descripcion: valores.descripcion_block.descripcion_input.value || null,
      fecha: fechaCompleta,
    });

    // Refresca la Home Tab
    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al guardar edición:', error);
  }
});

// --- ACCIÓN: paginación de completadas ---
// Estos handlers navegan entre las páginas de tareas completadas.
// Cada uno obtiene el número de página del "value" del botón clickeado
// y reconstruye la Home Tab con esa página.

// Botón "◀ Anterior": retrocede una página
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

// Botón "Siguiente ▶": avanza una página
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

// Botón indicador de página: es solo visual, no realiza ninguna acción.
// Se requiere un handler para que Bolt no lance error por action_id no registrado.
app.action('paginas_indicator', async ({ ack }) => {
  await ack();
});


// ==========================================
// 5. INICIO DEL SERVIDOR
// ==========================================
// Se usa receiver.start() en vez de app.start() para evitar que Bolt levante
// su propio servidor Express. Así Railway (u otro PaaS) puede manejar el puerto
// y el endpoint /health funciona correctamente en el mismo servidor.

(async () => {
  const port = process.env.PORT || 3000;
  await receiver.start(port);
  console.log(`⚡️ App corriendo en el puerto ${port}`);
})();