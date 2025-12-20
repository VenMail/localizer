declare module 'vue' {
  export const ref: any;
  export const computed: any;
  export const onMounted: any;
  export const onUnmounted: any;
  export type Ref<_T = any> = any;
  const _default: any;
  export default _default;
}

declare module '*.vue' {
  const component: any;
  export default component;
}
