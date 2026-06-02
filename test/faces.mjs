import fs from "node:fs"; import jpeg from "jpeg-js"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cv = require("../opencv.js"); await new Promise(r=>{cv.onRuntimeInitialized=r;});
const RD = require("../detector.js");
const FILE = process.argv[2] || "test3.jpg";
const img = jpeg.decode(fs.readFileSync(new URL("../"+FILE,import.meta.url)),{useTArray:true});
const W=img.width,H=img.height;
const src = cv.matFromImageData({data:img.data,width:W,height:H});
const faces = RD.detectFaces(cv, src);
console.log(`${FILE} ${W}x${H}: detectFaces -> ${faces.length} face(s)`);
faces.forEach((f,i)=>{ console.log(`FACE ${i+1} (${f.stickerCount} stickers):`); for(let r=0;r<9;r+=3) console.log("  "+f.face.cells.slice(r,r+3).map(c=>c.code).join(" ")); });
// draw
const out = new Uint8Array(img.data);
function p(x,y,c){x|=0;y|=0;if(x<0||y<0||x>=W||y>=H)return;const i=(y*W+x)*4;out[i]=c[0];out[i+1]=c[1];out[i+2]=c[2];out[i+3]=255;}
function line(a,b,c){const dx=Math.abs(b.x-a.x),dy=Math.abs(b.y-a.y),st=Math.max(dx,dy);for(let i=0;i<=st;i++){const t=st?i/st:0;p(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,c);}}
const COL=[[255,0,255],[0,220,255],[255,220,0]];
faces.forEach((f,fi)=>{const c=f.corners.map(RD.orderCorners?(x=>x):(x=>x)); const o=RD.orderCorners(f.corners); for(let i=0;i<4;i++)for(let t=0;t<3;t++){const a={x:o[i].x,y:o[i].y+t},b={x:o[(i+1)%4].x,y:o[(i+1)%4].y+t};line(o[i],o[(i+1)%4],COL[fi%3]);}});
fs.writeFileSync(new URL("../detected.jpg",import.meta.url),jpeg.encode({data:out,width:W,height:H},92).data);
console.log("wrote detected.jpg");
