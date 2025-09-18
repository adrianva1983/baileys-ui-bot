<?php
// Indicamos que la respuesta será en JSON
header('Content-Type: application/json; charset=utf-8');

// Creamos un array con la estructura deseada
$data = [
    [
        "nombre" => "Juan Pérez",
        "movil"  => "644619636",
        "url"    => "https://ejemplo.com/juan"
    ],
    [
        "nombre" => "María López",
        "movil"  => "644619636",
        "url"    => "https://ejemplo.com/maria"
    ],
    [
        "nombre" => "Carlos Sánchez",
        "movil"  => "644619636",
        "url"    => "https://ejemplo.com/carlos"
    ]
];

// Devolvemos el JSON
echo json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
