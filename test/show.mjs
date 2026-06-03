import fs from "node:fs"; import jpeg from "jpeg-js"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const cv = require("../opencv.js"); await new Promise(r=>{cv.onRuntimeInitialized=r;});
const RD = require("../detector.js");
const FILE=process.argv[2]||"userimg.jpg";
const img=jpeg.decode(fs.readFileSync(new URL("../"+FILE,import.meta.url)),{useTArray:true});
const W=img.width,H=img.height;
const src=cv.matFromImageData({data:img.data,width:W,height:H});
const faces=RD.detectFacesGeometric(cv,src);
const wf=faces[0]&&faces[0].wireframe;
if(wf)console.log("near:",`(${wf.near.x|0},${wf.near.y|0})`,"ring:",wf.ring.map(p=>`(${p.x|0},${p.y|0})`).join(" "),"ss",wf.sideStart);
const o=new Uint8Array(img.data);
function p(x,y,c){x|=0;y|=0;if(x<0||y<0||x>=W||y>=H)return;const i=(y*W+x)*4;o[i]=c[0];o[i+1]=c[1];o[i+2]=c[2];o[i+3]=255;}
function line(a,b,c){const st=Math.max(Math.abs(b.x-a.x),Math.abs(b.y-a.y))|0;for(let i=0;i<=st;i++){const t=st?i/st:0;for(let w=-2;w<=2;w++){p(a.x+(b.x-a.x)*t+w,a.y+(b.y-a.y)*t,c);p(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t+w,c);}}}
const FC=[[255,0,255],[0,220,255],[255,220,0]];
faces.forEach((f,fi)=>{const q=f.corners;for(let i=0;i<4;i++)line(q[i],q[(i+1)%4],FC[fi%3]);});
if(wf)for(const pt of [wf.near,...wf.ring])for(let dy=-7;dy<=7;dy++)for(let dx=-7;dx<=7;dx++)if(dx*dx+dy*dy<=49)p(pt.x+dx,pt.y+dy,[255,0,0]);
fs.writeFileSync(new URL("../detected.jpg",import.meta.url),jpeg.encode({data:o,width:W,height:H},92).data);
