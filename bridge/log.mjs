const stamp = () => new Date().toISOString();

export default {
  info: (msg) => console.log(`${stamp()} ${msg}`),
  error: (msg) => console.error(`${stamp()} ${msg}`),
};
