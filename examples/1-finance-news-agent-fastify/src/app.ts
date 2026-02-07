import Fastify from 'fastify';
import routes from './routes';

export const app = Fastify({
  logger: true,
});

app.register(routes);
