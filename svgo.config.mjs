export default {
  multipass: true,

  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          cleanupIds: false,
          removeDesc: false,
        },
      },
    },
  ],
};
