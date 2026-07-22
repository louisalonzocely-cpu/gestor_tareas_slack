require('dotenv').config();
const { App, ExpressReceiver } = require('@slack/bolt');
const { obtenerTareas, crearTarea, actualizarCompletada } = require('./db');

// 1. Configurar ExpressReceiver registrando /health como customRoute
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events', // Asegura explícitamente la ruta de eventos
  customRoutes: [
    {
      path: '/health',
      method: ['GET'],
      handler: (req, res) => {
        res.status(200).send('ok');
      },
    },
  ],
});

// Middleware de Logs para verificar en Railway que las peticiones entran
receiver.router.use((req, res, next) => {
  console.log('📥 Petición recibida:', req.method, req.path);
  next();
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

async function construirVistaHome(userId) {
  const tareas = await obtenerTareas(userId);

  const blocksBase = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🗒️ Gestor de Tareas Diarias', emoji: true },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'plain_text', text: 'Con esta App puedes gestionar tus tareas fácilmente.', emoji: true },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📝 Crear una tarea', emoji: true },
          action_id: 'abrir_modal_tarea',
        },
      ],
    },
    { type: 'divider' },
  ];

  if (tareas.length === 0) {
    blocksBase.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No tienes tareas registradas todavía._' },
    });
  } else {
    tareas.forEach((tarea) => {
      const tituloTexto = tarea.completada ? `~${tarea.titulo}~` : `*${tarea.titulo}*`;
      const detalle = [
        tarea.descripcion || null,
        tarea.fecha ? `📅 ${tarea.fecha}` : null,
      ].filter(Boolean).join('\n');

      blocksBase.push({
        type: 'section',
        block_id: `tarea_${tarea.id}`,
        text: {
          type: 'mrkdwn',
          text: `${tituloTexto}${detalle ? `\n${detalle}` : ''}`,
        },
        accessory: {
          type: 'checkboxes',
          action_id: 'toggle_tarea',
          options: [
            {
              text: { type: 'plain_text', text: 'Completada', emoji: true },
              value: String(tarea.id),
            },
          ],
          ...(tarea.completada && {
            initial_options: [
              {
                text: { type: 'plain_text', text: 'Completada', emoji: true },
                value: String(tarea.id),
              },
            ],
          }),
        },
      });
    });
  }

  return { type: 'home', blocks: blocksBase };
}

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

app.action('abrir_modal_tarea', async ({ ack, body, client }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_tarea',
        title: { type: 'plain_text', text: 'Nueva tarea' },
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

app.view('submit_tarea', async ({ ack, body, view, client }) => {
  await ack();
  const valores = view.state.values;
  const usuario = body.user.id;

  try {
    await crearTarea({
      usuarioId: usuario,
      titulo: valores.titulo_block.titulo_input.value,
      descripcion: valores.descripcion_block.descripcion_input.value,
      fecha: valores.fecha_block.fecha_input.selected_date,
    });

    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al guardar tarea:', error);
  }
});

app.action('toggle_tarea', async ({ ack, body, client }) => {
  await ack();
  const usuario = body.user.id;
  const accion = body.actions[0];
  const tareaId = accion.selected_options[0]?.value;
  const completada = accion.selected_options.length > 0;

  try {
    if (tareaId) await actualizarCompletada(tareaId, completada);

    await client.views.publish({
      user_id: usuario,
      view: await construirVistaHome(usuario),
    });
  } catch (error) {
    console.error('❌ Error al actualizar tarea:', error);
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ App corriendo en el puerto ${port}`);
})();

