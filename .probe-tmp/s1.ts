console.log('step 1');
import('three-mesh-bvh').then(m => console.log('bvh ok', typeof m.MeshBVH), e => console.log('bvh ERR', e.message));
