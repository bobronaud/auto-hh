/**
 * Типы для импорта картинок: vite превращает такой импорт в URL с хешем, tsc об
 * этом не знает. Объявление живёт здесь, а не в `types: ["vite/client"]` корневого
 * tsconfig, — он один на сервер и UI, и глобальные типы vite попали бы в серверный код.
 */
declare module '*.png' {
  const src: string
  export default src
}
