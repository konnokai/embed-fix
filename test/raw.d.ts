// Vite 的 ?raw 匯入；放在沒有 import 的檔案裡，才會是全域宣告而不是 module augmentation。
declare module "*.html?raw" {
  const content: string;
  export default content;
}
