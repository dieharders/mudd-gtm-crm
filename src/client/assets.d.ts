/** Bun serves an imported image as a file and hands the module its URL. */
declare module "*.png" {
  const url: string;
  export default url;
}
