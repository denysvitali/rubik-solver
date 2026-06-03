import fs from "node:fs"; import jpeg from "jpeg-js"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const cv = require("../opencv.js"); await new Promise(r=>{cv.onRuntimeInitialized=r;});
const RD = require("../detector.js");
const FILE=process.argv[2]||"userimg.jpg";
const img=jpeg.decode(fs.readFileSync(new URL("../"+FILE,import.meta.url)),{useTArray:true});
const W=img.width,H=img.height;const src=cv.matFromImageData({data:img.data,width:W,height:H});
const rs=new cv.Mat();cv.resize(src,rs,new cv.Size(320,320),0,0,cv.INTER_AREA);
const rgb=new cv.Mat();cv.cvtColor(rs,rgb,cv.COLOR_RGBA2RGB);const d=rgb.data;
const mean=[0.485,0.456,0.406],std=[0.229,0.224,0.225];const inp=new Float32Array(3*320*320);
for(let i=0;i<320*320;i++)for(let c=0;c<3;c++)inp[c*320*320+i]=((d[i*3+c]/255)-mean[c])/std[c];
const sess=await ort.InferenceSession.create("./u2netp.onnx");
const out=await sess.run({[sess.inputNames[0]]:new ort.Tensor("float32",inp,[1,3,320,320])});
const sal=out[sess.outputNames[0]].data;let mn=1e9,mx=-1e9;for(const v of sal){if(v<mn)mn=v;if(v>mx)mx=v;}
const m320=new cv.Mat(320,320,cv.CV_8U);for(let i=0;i<320*320;i++)m320.data[i]=((sal[i]-mn)/(mx-mn))>0.5?255:0;
const cubeMask=new cv.Mat();cv.resize(m320,cubeMask,new cv.Size(W,H),0,0,cv.INTER_NEAREST);
const faces=RD.detectFacesGeometric(cv,src,{cubeMask});const wf=faces[0].wireframe;const ring=wf.ring,near=wf.near;
// axis-alignment score of a warped face: gradient energy near 0/90 vs 45/135
function warpScore(q){const S=240;const srcT=cv.matFromArray(4,1,cv.CV_32FC2,[q[0].x,q[0].y,q[1].x,q[1].y,q[2].x,q[2].y,q[3].x,q[3].y]);
  const dstT=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,S,0,S,S,0,S]);const M=cv.getPerspectiveTransform(srcT,dstT);const w=new cv.Mat();
  cv.warpPerspective(src,w,M,new cv.Size(S,S),cv.INTER_LINEAR,cv.BORDER_REPLICATE,new cv.Scalar());
  const g=new cv.Mat();cv.cvtColor(w,g,cv.COLOR_RGBA2GRAY);const gx=new cv.Mat(),gy=new cv.Mat();cv.Scharr(g,gx,cv.CV_32F,1,0);cv.Scharr(g,gy,cv.CV_32F,0,1);
  let axis=0,diag=0;for(let i=0;i<S*S;i++){const a=Math.abs(gx.data32F[i]),b=Math.abs(gy.data32F[i]);axis+=Math.abs(a-b);diag+=Math.min(a,b);}
  srcT.delete();dstT.delete();M.delete();w.delete();g.delete();gx.delete();gy.delete();
  return {w:S, score: axis/(diag+1)};}
for(let off=0;off<2;off++){
  let tot=0;const mont=[];
  for(let k=0;k<3;k++){const a=(off+2*k)%6,b=(a+1)%6,c=(a+2)%6;const q=[near,ring[a],ring[b],ring[c]];const r=warpScore(q);tot+=r.score;}
  console.log(`alternation off=${off}: axis/diag score = ${(tot/3).toFixed(2)} (higher=more axis-aligned=correct)`);
}
console.log("detector chose sideStart =",wf.sideStart);
