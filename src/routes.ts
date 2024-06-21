import { IRequestStrict, Router } from 'itty-router';
import render2 from 'render2';

import { Env } from './types';


type CF = [env: Env, ctx: ExecutionContext];
const router = Router<IRequestStrict, CF>();

// tiny html page for root
router.get('/', () => new Response(`
<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<link rel="icon" href="https://boymoder.org/1719009115" type="image/x-icon" />
		<meta property="og:title" content="boymoder.org" />
		<meta property="og:image" content="https://boymoder.org/1719009115" />
		<title>boymoder.org</title>
	</head>
	<body>
		<div id="test">
			<img
				id="rise"
				src="https://boymoder.org/1719009163"
				onclick="playAudio()"
			/>
		</div>
		<audio id="audio" controls hidden>
			<source src="https://boymoder.org/1719009180" type="audio/mpeg" />
		</audio>
	<script>
		var audio = document.getElementById("audio");
		audio.volume = 0.5;
		
		function playAudio() {
			if (audio.paused) {
				audio.play();
			} else {
				audio.pause();
				audio.currentTime = 0;
			}
		}
	</script>
		
	</body>
</html>

`, {
	headers: {
		'content-type': 'text/html',
	},
}));

// handle authentication
const authMiddleware = (request: IRequestStrict, env: Env) => {
	const url = new URL(request.url);
	if (request.headers?.get('x-auth-key') !== env.AUTH_KEY && url.searchParams.get('authkey') !== env.AUTH_KEY) {
		return new Response(JSON.stringify({
			success: false,
			error: 'Missing auth',
		}), {
			status: 401,
			headers: {
				'content-type': 'application/json',
			},
		});
	}
};

const notFound = error => new Response(JSON.stringify({
	success: false,
	error: error ?? 'Not Found',
}), {
	status: 404,
	headers: {
		'content-type': 'application/json',
	},
});

// handle upload
router.post('/upload', authMiddleware, async (request, env) => {
	const url = new URL(request.url);
	let fileslug = url.searchParams.get('filename');
	if (!fileslug) {
		fileslug = Math.floor(Date.now() / 1000).toString();
	}
	const filename = `${fileslug}`;

	// ensure content-length and content-type headers are present
	const contentType = request.headers.get('content-type');
	const contentLength = request.headers.get('content-length');
	if (!contentLength || !contentType) {
		return new Response(JSON.stringify({
			success: false,
			message: 'content-length and content-type are required',
		}), {
			status: 400,
			headers: {
				'content-type': 'application/json',
			},
		});
	}

	// write to R2
	try {
		await env.R2_BUCKET.put(filename, request.body, {
			httpMetadata: {
				contentType: contentType,
				cacheControl: 'public, max-age=604800',
			},
		});
	} catch (error) {
		return new Response(JSON.stringify({
			success: false,
			message: 'Error occured writing to R2',
			error: {
				name: error.name,
				message: error.message,
			},
		}), {
			status: 500,
			headers: {
				'content-type': 'application/json',
			},
		});
	}

	// return the image url to ShareX
	const returnUrl = new URL(request.url);
	returnUrl.searchParams.delete('filename');
	returnUrl.pathname = `/${filename}`;
	if (env.CUSTOM_PUBLIC_BUCKET_DOMAIN) {
		returnUrl.host = env.CUSTOM_PUBLIC_BUCKET_DOMAIN;
		returnUrl.pathname = filename;
	}

	const deleteUrl = new URL(request.url);
	deleteUrl.pathname = '/delete';
	deleteUrl.searchParams.set('authkey', env.AUTH_KEY);
	deleteUrl.searchParams.set('filename', filename);

	return new Response(JSON.stringify({
		success: true,
		image: returnUrl.href,
		deleteUrl: deleteUrl.href,
	}), {
		headers: {
			'content-type': 'application/json',
		},
	});
});

// handle file retrieval
const getFile = async (request: IRequestStrict, env: Env, ctx: ExecutionContext) => {
	if (env.ONLY_ALLOW_ACCESS_TO_PUBLIC_BUCKET) {
		return notFound('Not Found');
	}
	const url = new URL(request.url);
	const id = url.pathname.slice(1);
	console.log(id);

	if (!id) {
		return notFound('Missing ID');
	}

	const imageReq = new Request(`https://r2host/${id}`, request);
	const imageRes = await render2.fetch(imageReq, {
		...env,
		CACHE_CONTROL: 'public, max-age=604800',
	}, ctx);

	// Add OpenGraph metadata to the image response
	const metadata = {
		title: 'My Image',
		image: `https://example.com/${id}`,
		description: 'This is an image',
	};
	const metadataHeaders = Object.entries(metadata).map(([key, value]) => [`og:${key}`, value]);
	const headers = new Headers(imageRes.headers);
	for (const [key, value] of metadataHeaders) { headers.set(key, value); }

	return new Response(imageRes.body, {
		status: imageRes.status,
		statusText: imageRes.statusText,
		headers,
	});
};

// handle file deletion
router.get('/delete', authMiddleware, async (request, env) => {
	const url = new URL(request.url);
	const filename = url.searchParams.get('filename');

	if (!filename) {
		return notFound('Missing filename');
	}

	// delete from R2
	try {
		const cache = caches.default;
		await cache.delete(new Request(`https://r2host/${filename}`, request));

		await env.R2_BUCKET.delete(filename);
		return new Response(JSON.stringify({
			success: true,
		}), {
			headers: {
				'content-type': 'application/json',
			},
		});
	} catch (error) {
		return new Response(JSON.stringify({
			success: false,
			message: 'Error occurred deleting from R2',
			error: {
				name: error.name,
				message: error.message,
			},
		}), {
			status: 500,
			headers: {
				'content-type': 'application/json',
			},
		});
	}
});

router.get('/upload/:id', getFile);
router.get('/*', getFile);
router.head('/*', getFile);

router.get('/list', authMiddleware, async (request, env) => {
	const items = await env.R2_BUCKET.list({ limit: 1000 });
	return new Response(JSON.stringify(items, null, 2), {
		headers: {
			'content-type': 'application/json',
		},
	});
});

router.all('*', () => notFound('Not Found'));

export { router };
